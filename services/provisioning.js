'use strict';
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { execFileSync } = require('child_process');
const db     = require('../db');

const TICKET_TTL_MINUTES = 5;
const CERT_DAYS = 400; // deployment-scale per docs/level2.md §30.5, not the CA's own multi-year life

const TLS_DIR = path.join(__dirname, '..', 'data', 'tls');
const CA_DB_DIR = path.join(TLS_DIR, 'ca-db');
const INDEX_FILE = path.join(CA_DB_DIR, 'index.txt');
const INDEX_ATTR_FILE = path.join(CA_DB_DIR, 'index.txt.attr');
const SERIAL_FILE = path.join(CA_DB_DIR, 'serial');
const CRLNUMBER_FILE = path.join(CA_DB_DIR, 'crlnumber');
const CONF_FILE = path.join(CA_DB_DIR, 'openssl.cnf');
const CRL_FILE = path.join(TLS_DIR, 'ca.crl');
const CA_CERT = path.join(TLS_DIR, 'ca.crt');
const CA_KEY = path.join(TLS_DIR, 'ca.key');

const ROLES = ['apparatus', 'scoresheet', 'remote', 'var'];
const DEVICE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const stmtInsertTicket = db.prepare(`
  INSERT INTO tier_a_tickets (code, role, device_label, created_by, expires_at)
  VALUES (@code, @role, @deviceLabel, @createdBy, datetime('now', @ttl))
`);
const stmtFindLiveByCode = db.prepare(`
  SELECT * FROM tier_a_tickets
  WHERE code = ? AND redeemed_at IS NULL AND expires_at > datetime('now')
`);
const stmtRedeemTicket = db.prepare(`
  UPDATE tier_a_tickets SET redeemed_at = datetime('now') WHERE id = ?
`);
const stmtListTickets = db.prepare(`
  SELECT id, code, role, device_label, created_at, expires_at, redeemed_at
  FROM tier_a_tickets ORDER BY created_at DESC LIMIT 50
`);

const stmtInsertCert = db.prepare(`
  INSERT INTO tier_a_certificates (serial, device_id, role, device_label, cert_pem)
  VALUES (@serial, @deviceId, @role, @deviceLabel, @certPem)
`);
const stmtFindCertById = db.prepare('SELECT * FROM tier_a_certificates WHERE id = ?');
const stmtListCerts = db.prepare(`
  SELECT id, serial, device_id, role, device_label, issued_at, revoked_at
  FROM tier_a_certificates ORDER BY issued_at DESC
`);
const stmtRevokeCertRow = db.prepare(`
  UPDATE tier_a_certificates SET revoked_at = datetime('now') WHERE id = ?
`);
const stmtFindActiveCertsForDevice = db.prepare(`
  SELECT id FROM tier_a_certificates
  WHERE device_id = ? AND role = ? AND revoked_at IS NULL AND id != ?
`);
const stmtPurgeRevokedCerts = db.prepare(`
  DELETE FROM tier_a_certificates WHERE revoked_at IS NOT NULL
`);
const stmtDeleteCertBySerial = db.prepare(`
  DELETE FROM tier_a_certificates WHERE serial = ?
`);

function randomCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Bootstrap the minimal OpenSSL CA-database files needed for `openssl ca -gencrl`
// (index.txt/serial/crlnumber/config) — a lightweight bookkeeping layer alongside
// the existing ad-hoc CA (scripts/generate-tls-cert.sh), not a rework of how the CA
// itself or the HTTPS/broker leaf certs get issued. Idempotent — safe to call on
// every signCertificate/revokeCertificate.
function ensureCaDb() {
  // A device keeps the same CN ({role}-{deviceId}) across every re-provisioning —
  // that's what lets a superseded certificate be found and revoked by identity.
  // OpenSSL's `ca` tooling enforces unique subjects by default (an index.txt.attr
  // file, separate from index.txt itself, controls this) and refuses to even load
  // the database otherwise — confirmed the hard way: `openssl ca -gencrl` failed
  // outright ("Error creating name index") the first time a second certificate
  // was ever issued for an already-seen device+role. Checked independently of the
  // rest of this bootstrap so an already-existing ca-db/ from before this fix
  // still gets it.
  if (!fs.existsSync(INDEX_ATTR_FILE)) {
    fs.mkdirSync(CA_DB_DIR, { recursive: true });
    fs.writeFileSync(INDEX_ATTR_FILE, 'unique_subject = no\n');
  }

  if (fs.existsSync(INDEX_FILE)) return;
  fs.mkdirSync(CA_DB_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, '');
  fs.writeFileSync(SERIAL_FILE, '1000\n');
  fs.writeFileSync(CRLNUMBER_FILE, '1000\n');
  fs.writeFileSync(CONF_FILE, `[ca]
default_ca = tier_a_ca

[tier_a_ca]
dir = ${CA_DB_DIR}
database = ${INDEX_FILE}
certificate = ${CA_CERT}
private_key = ${CA_KEY}
crlnumber = ${CRLNUMBER_FILE}
default_md = sha256
default_crl_days = 30
policy = policy_any

[policy_any]
commonName = supplied
`);
}

function nextSerialHex() {
  const current = fs.readFileSync(SERIAL_FILE, 'utf8').trim();
  const next = (BigInt('0x' + current) + 1n).toString(16);
  fs.writeFileSync(SERIAL_FILE, next.padStart(current.length, '0') + '\n');
  return current;
}

// index.txt entry dates are OpenSSL's own YYMMDDHHMMSSZ format.
function opensslDate(date) {
  return date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
}

function parseOpensslDate(str) {
  const yy = str.slice(0, 2), mo = str.slice(2, 4), dd = str.slice(4, 6);
  const hh = str.slice(6, 8), mi = str.slice(8, 10), ss = str.slice(10, 12);
  return new Date(`20${yy}-${mo}-${dd}T${hh}:${mi}:${ss}Z`);
}

const Provisioning = {
  // Operator side — mirrors services/pairing.js's old ticket-code shape, scoped to a
  // single publisher role per docs/level2.md §30.5 ("role" field, never "software").
  createTicket(role, deviceLabel, createdByUserId) {
    if (!ROLES.includes(role)) throw new Error(`Invalid role: ${role}`);
    let code;
    for (let attempt = 0; attempt < 10; attempt++) {
      code = randomCode();
      if (!stmtFindLiveByCode.get(code)) break;
    }
    const { lastInsertRowid } = stmtInsertTicket.run({
      code, role, deviceLabel: deviceLabel || null, createdBy: createdByUserId,
      ttl: `+${TICKET_TTL_MINUTES} minutes`,
    });
    return { id: lastInsertRowid, code, role, ttlMinutes: TICKET_TTL_MINUTES };
  },

  listTickets() {
    return stmtListTickets.all();
  },

  // Device side, via lib/opp2Provisioning.js — verifies the ticket, signs the CSR
  // against Atlas's own CA, and records the issuance. Returns { certPem, caCertPem }
  // or null if the ticket is invalid/expired/already redeemed.
  signCertificate({ code, role, deviceId, deviceLabel, csrPem }) {
    if (!ROLES.includes(role)) return null;
    if (!DEVICE_ID_RE.test(deviceId || '')) return null;
    const ticket = stmtFindLiveByCode.get(code);
    if (!ticket || ticket.role !== role) return null;

    ensureCaDb();

    const tmpDir = fs.mkdtempSync('/tmp/atlas-tier-a-');
    const csrPath = path.join(tmpDir, 'req.csr');
    const certPath = path.join(tmpDir, 'cert.pem');
    const extPath = path.join(tmpDir, 'ext.cnf');
    try {
      fs.writeFileSync(csrPath, csrPem);

      // Reject a malformed/tampered CSR before it ever reaches the CA key.
      execFileSync('openssl', ['req', '-in', csrPath, '-verify', '-noout'], { stdio: 'pipe' });

      const serial = nextSerialHex();
      // CN is Atlas-controlled ({role}-{deviceId}, both already validated above) and
      // maps directly to a Mosquitto `user <CN>` ACL stanza — the CSR's own embedded
      // subject is discarded; only its public key is used.
      const cn = `${role}-${deviceId}`;
      fs.writeFileSync(extPath,
        'basicConstraints=CA:FALSE\n' +
        'keyUsage=digitalSignature,keyEncipherment\n' +
        'extendedKeyUsage=clientAuth\n');

      execFileSync('openssl', [
        'x509', '-req',
        '-in', csrPath,
        '-CA', CA_CERT, '-CAkey', CA_KEY,
        '-set_serial', `0x${serial}`,
        '-out', certPath,
        '-days', String(CERT_DAYS),
        '-subj', `/O=OpenPiste/CN=${cn}`,
        '-extfile', extPath,
      ], { stdio: 'pipe' });

      const certPem = fs.readFileSync(certPath, 'utf8');
      const caCertPem = fs.readFileSync(CA_CERT, 'utf8');

      const expiry = opensslDate(new Date(Date.now() + CERT_DAYS * 86400000));
      fs.appendFileSync(INDEX_FILE, `V\t${expiry}\t\t${serial}\tunknown\t/O=OpenPiste/CN=${cn}\n`);

      stmtRedeemTicket.run(ticket.id);
      // The device itself never sends a label in practice (the firmware's
      // /provision form only asks for the ticket code and role) — fall back to
      // whatever the operator typed when issuing the ticket, since that's already
      // the meaningful name for this device and shouldn't need re-entering.
      const label = deviceLabel || ticket.device_label || null;
      const { lastInsertRowid } = stmtInsertCert.run({ serial, deviceId, role, deviceLabel: label, certPem });

      // A device can only ever hold one certificate at a time (a fresh grant
      // overwrites its NVS storage, per TierAProvisioning::HandleResponse on the
      // firmware side) — so any previous certificate for this exact device+role
      // is now provably unused and should stop being trusted, not linger as a
      // separate "active" row indefinitely. Re-provisioning is meant to
      // supersede, not accumulate.
      for (const row of stmtFindActiveCertsForDevice.all(deviceId, role, lastInsertRowid)) {
        Provisioning.revokeCertificate(row.id);
      }

      return { certPem, caCertPem, serial };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },

  listCertificates() {
    return stmtListCerts.all();
  },

  // Marks revoked in Atlas's DB, updates the OpenSSL CA index, and regenerates
  // ca.crl. Actually cutting broker access still needs scripts/sync-mosquitto-tier-a.sh
  // to push the new CRL to Mosquitto — same two-step shape as Tier B revocation
  // (services/pairing.js's revokeCredential + scripts/sync-mosquitto-scoresheet-acl.sh).
  revokeCertificate(id) {
    const row = stmtFindCertById.get(id);
    if (!row || row.revoked_at) return row || null;

    ensureCaDb();
    const index = fs.readFileSync(INDEX_FILE, 'utf8').split('\n');
    const revokedAt = opensslDate(new Date());
    const updated = index.map((line) => {
      const fields = line.split('\t');
      if (fields[0] === 'V' && fields[3] === row.serial) {
        return `R\t${fields[1]}\t${revokedAt}\t${fields[3]}\t${fields[4]}\t${fields[5]}`;
      }
      return line;
    });
    fs.writeFileSync(INDEX_FILE, updated.join('\n'));

    execFileSync('openssl', ['ca', '-config', CONF_FILE, '-gencrl', '-out', CRL_FILE], { stdio: 'pipe' });

    stmtRevokeCertRow.run(id);
    return stmtFindCertById.get(id);
  },

  // Removes revoked rows from Atlas's own operator-facing list only — deliberately
  // does NOT touch the OpenSSL CA index or regenerate the CRL, so a previously
  // revoked certificate stays revoked/untrusted at the broker forever, exactly as
  // it should. Purely a "stop showing me old clutter in pairing.html" cleanup,
  // not an un-revoke.
  purgeRevokedCertificates() {
    const { changes } = stmtPurgeRevokedCerts.run();
    return { purged: changes };
  },

  // A revoked certificate's index.txt/CRL entry only needs to exist until the
  // certificate's own original expiry passes — after that, the TLS handshake
  // already rejects it for being expired regardless of CRL presence, so keeping
  // the entry any longer serves no security purpose, only unbounded growth (see
  // docs/implementation-notes/mosquitto-security.md's revocation-scaling note).
  // Drops those entries from index.txt (source of truth for CRL generation),
  // regenerates ca.crl to match, and drops the corresponding Atlas DB row if one
  // is still present (it may already be gone via purgeRevokedCertificates()).
  // Called from scripts/sync-mosquitto-tier-a.sh, the same script that already
  // has to run after any revocation to push the CRL — not meant to be run on
  // its own.
  pruneExpiredRevocations() {
    ensureCaDb();
    if (!fs.existsSync(INDEX_FILE)) return { pruned: 0 };

    const now = new Date();
    const prunedSerials = [];
    const kept = fs.readFileSync(INDEX_FILE, 'utf8').split('\n').filter((line) => {
      if (!line.trim()) return true;
      const [status, expiry, , serial] = line.split('\t');
      const expired = status === 'R' && expiry && parseOpensslDate(expiry) < now;
      if (expired) prunedSerials.push(serial);
      return !expired;
    });

    if (prunedSerials.length === 0) return { pruned: 0 };

    fs.writeFileSync(INDEX_FILE, kept.join('\n'));
    execFileSync('openssl', ['ca', '-config', CONF_FILE, '-gencrl', '-out', CRL_FILE], { stdio: 'pipe' });

    const deleteMany = db.transaction((serials) => {
      for (const serial of serials) stmtDeleteCertBySerial.run(serial);
    });
    deleteMany(prunedSerials);

    return { pruned: prunedSerials.length };
  },
};

module.exports = Provisioning;
