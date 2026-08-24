'use strict';
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { execFileSync } = require('child_process');
const db     = require('../db');

const TICKET_TTL_MINUTES = 5;
const CERT_DAYS = 400; // deployment-scale per docs/level2.md §30.5, not the CA's own multi-year life

// The CRL's own nextUpdate window. A relying party (Mosquitto/OpenSSL) refuses to
// trust a CRL once this window has passed, regardless of whether anything on it
// changed — and this CRL is pushed to the broker by a manual/cron script, not
// fetched live, so a missed sync doesn't just risk a late-propagating revocation,
// it eventually rejects every Tier A certificate at once (confirmed the hard way,
// 2026-08-15: a CRL last synced 2026-07-14/15 went stale ~30 days later and broke
// mTLS broker-wide, including the CMS's own always-valid certificate). 180 days
// gives a wide safety margin for a manually-run sync; actual revocation
// propagation speed is governed entirely by how often sync-mosquitto-tier-a.sh
// runs, not by this window — see docs/implementation-notes/mosquitto-security.md.
const CRL_VALIDITY_DAYS = 180;
// How close to staleness before the CMS surfaces a warning (see getCrlDeploymentStatus).
const CRL_WARNING_DAYS = 14;

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

// Where scripts/sync-mosquitto-tier-a.sh installs the CRL. Atlas's own process
// (running unprivileged) can never read this file's contents (root:mosquitto,
// 640) — but fs.stat only needs execute permission on the parent directory, which
// is world-readable, so its mtime is visible with no elevated access at all. That
// mtime is a faithful proxy for the CRL's own "Last Update" field, since the sync
// script always installs a freshly-copied file (never edits in place).
const DEPLOYED_CRL_PATH = '/etc/mosquitto/certs/ca.crl';

// The privileged tail of Tier A CRL sync (push, listener-conf rewrite, broker
// restart) — split into its own script (2026-08-24) precisely so it alone can be
// granted passwordless sudo, without also elevating pruneExpiredRevocations/
// refreshCrl below, which must keep running as the same unprivileged user that
// owns data/tls/. See pushCrlToBroker() and scripts/push-tier-a-crl.sh's header.
const PUSH_CRL_SCRIPT = path.join(__dirname, '..', 'scripts', 'push-tier-a-crl.sh');

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

  // Config is pure and stateless (unlike index.txt/serial/crlnumber, which track
  // real issuance history) — always rewritten so a constant change like
  // CRL_VALIDITY_DAYS actually takes effect on an already-provisioned deployment,
  // rather than silently freezing at whatever value was in place the first time
  // ensureCaDb() ever ran on this machine.
  fs.mkdirSync(CA_DB_DIR, { recursive: true });
  fs.writeFileSync(CONF_FILE, `[ca]
default_ca = tier_a_ca

[tier_a_ca]
dir = ${CA_DB_DIR}
database = ${INDEX_FILE}
certificate = ${CA_CERT}
private_key = ${CA_KEY}
crlnumber = ${CRLNUMBER_FILE}
default_md = sha256
default_crl_days = ${CRL_VALIDITY_DAYS}
policy = policy_any

[policy_any]
commonName = supplied
`);

  if (fs.existsSync(INDEX_FILE)) return;
  fs.writeFileSync(INDEX_FILE, '');
  fs.writeFileSync(SERIAL_FILE, '1000\n');
  fs.writeFileSync(CRLNUMBER_FILE, '1000\n');
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

// Signs a CSR against Atlas's own CA. No ticket/ROLES check here — callers decide
// who's allowed to reach this (signCertificate gates external Tier A devices to
// ROLES via a redeemed ticket; issueCmsCertificate is the one caller allowed to pass
// role: 'software', since it never goes through the ticket flow at all).
function _signCsr({ role, deviceId, csrPem }) {
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
    // CN is Atlas-controlled ({role}-{deviceId}) and maps directly to a Mosquitto
    // `user <CN>` ACL stanza — the CSR's own embedded subject is discarded; only
    // its public key is used.
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

    return { certPem, caCertPem, serial };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Records a freshly-issued certificate and revokes whatever it supersedes. A
// device/CN can only ever hold one live certificate at a time (a fresh grant
// overwrites its own storage — NVS on the firmware side, data/tls/software-client.*
// for the CMS itself) — so any previous certificate for this exact device+role is
// now provably unused and should stop being trusted, not linger as a separate
// "active" row indefinitely. Re-provisioning/re-issuance is meant to supersede, not
// accumulate.
function _recordAndSupersede({ serial, deviceId, role, deviceLabel, certPem }) {
  const { lastInsertRowid } = stmtInsertCert.run({ serial, deviceId, role, deviceLabel, certPem });
  for (const row of stmtFindActiveCertsForDevice.all(deviceId, role, lastInsertRowid)) {
    Provisioning.revokeCertificate(row.id);
  }
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

    const { certPem, caCertPem, serial } = _signCsr({ role, deviceId, csrPem });

    stmtRedeemTicket.run(ticket.id);
    // The device itself never sends a label in practice (the firmware's
    // /provision form only asks for the ticket code and role) — fall back to
    // whatever the operator typed when issuing the ticket, since that's already
    // the meaningful name for this device and shouldn't need re-entering.
    const label = deviceLabel || ticket.device_label || null;
    _recordAndSupersede({ serial, deviceId, role, deviceLabel: label, certPem });

    return { certPem, caCertPem, serial };
  },

  // Self-issuance for Atlas's own OPP2 client — the "shouldn't the CMS itself
  // authenticate to the broker" gap. Today lib/opp2Transport.js connects
  // anonymously and relies on the backward-compat anonymous
  // `topic write openpiste/+/software/#` grant, which also means any other
  // anonymous client on the network can spoof software/* messages the apparatus is
  // spec-required to trust unconditionally (e.g. software/clock's running:false
  // invariant). Unlike every other Tier A device, the CMS doesn't need the
  // ticket/MQTT request-response exchange at all — it already holds the CA's own
  // private key locally, so keypair generation, CSR, and signing all happen in one
  // local step. CN is fixed (software-cms): there is exactly one CMS per
  // deployment, so no per-instance device id is needed the way real external
  // hardware needs one. Writes the private key + cert straight to
  // data/tls/software-client.{key,crt} (the key never touches the DB, same as the
  // CA's own key) and records the cert in tier_a_certificates for the same
  // CRL/revocation/pruning machinery every other Tier A cert already gets.
  issueCmsCertificate() {
    ensureCaDb();
    const tmpDir = fs.mkdtempSync('/tmp/atlas-cms-cert-');
    const keyPath = path.join(tmpDir, 'cms.key');
    const csrPath = path.join(tmpDir, 'cms.csr');
    try {
      execFileSync('openssl', [
        'req', '-new', '-nodes',
        '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
        '-keyout', keyPath, '-out', csrPath,
        '-subj', '/O=OpenPiste/CN=software-cms',
      ], { stdio: 'pipe' });

      const keyPem = fs.readFileSync(keyPath, 'utf8');
      const csrPem = fs.readFileSync(csrPath, 'utf8');

      const { certPem, caCertPem, serial } = _signCsr({
        role: 'software', deviceId: 'cms', csrPem,
      });
      _recordAndSupersede({
        serial, deviceId: 'cms', role: 'software', deviceLabel: 'Atlas CMS (self)', certPem,
      });

      fs.writeFileSync(path.join(TLS_DIR, 'software-client.key'), keyPem, { mode: 0o600 });
      fs.writeFileSync(path.join(TLS_DIR, 'software-client.crt'), certPem);

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

  // Unconditionally regenerates data/tls/ca.crl with a fresh Last/Next Update,
  // even if nothing was revoked or pruned since the last run. Deliberately
  // separate from revokeCertificate/pruneExpiredRevocations (which only
  // regenerate when their own state actually changed) — scripts/sync-mosquitto-
  // tier-a.sh needs to be able to push a freshly-dated CRL on every routine run,
  // since "nothing changed" would otherwise mean the deployed CRL's nextUpdate
  // clock never gets reset and it goes stale on schedule regardless of how
  // diligently the sync script is run.
  refreshCrl() {
    ensureCaDb();
    execFileSync('openssl', ['ca', '-config', CONF_FILE, '-gencrl', '-out', CRL_FILE], { stdio: 'pipe' });
  },

  // The admin.html "Refresh CRL now" button's server-side entry point — the
  // in-process equivalent of running scripts/sync-mosquitto-tier-a.sh by hand.
  // Deliberately calls pruneExpiredRevocations/refreshCrl directly (unprivileged,
  // correct data/tls/ ownership) rather than shelling out to the full CLI script,
  // then execs *only* the privileged tail via sudo. Requires a one-time sudoers
  // grant for PUSH_CRL_SCRIPT specifically (see docs/e-scoresheet-standalone-design.md
  // §3.3.1's "Key files" note / the deploy instructions this ships with) — without
  // it this throws with sudo's own "a password is required" on stderr, which the
  // caller should surface as-is rather than a generic 500.
  pushCrlToBroker() {
    const { pruned } = this.pruneExpiredRevocations();
    this.refreshCrl();
    execFileSync('sudo', [PUSH_CRL_SCRIPT], { stdio: 'pipe' });
    return { pruned, ranAt: new Date().toISOString() };
  },

  // No-sudo staleness check for the CMS's own warning banner — see
  // DEPLOYED_CRL_PATH. Returns null if the broker/deployed CRL can't be statted
  // at all (e.g. Mosquitto not installed on this machine), which the caller
  // should treat as "unknown," not "stale."
  getCrlDeploymentStatus() {
    let stat;
    try {
      stat = fs.statSync(DEPLOYED_CRL_PATH);
    } catch {
      return null;
    }
    const lastSyncedAt = stat.mtime;
    const staleAt = new Date(lastSyncedAt.getTime() + CRL_VALIDITY_DAYS * 86400000);
    const daysRemaining = Math.floor((staleAt.getTime() - Date.now()) / 86400000);
    return {
      lastSyncedAt: lastSyncedAt.toISOString(),
      staleAt: staleAt.toISOString(),
      daysRemaining,
      isStale: daysRemaining <= 0,
      isWarning: daysRemaining <= CRL_WARNING_DAYS,
    };
  },
};

module.exports = Provisioning;
