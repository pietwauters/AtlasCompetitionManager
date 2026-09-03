# Atlas Administrator's Manual

Practical reference for running an Atlas installation: what to run when, and what
parameters matter. This is task-oriented — find the thing you need to do, run the
command shown. For *why* things are built the way they are, see the design docs each
section links to; this doc only covers the *how*.

All commands below assume you're in the repo root (`cd /path/to/AtlasCompetitionManager`)
unless stated otherwise.

## Quick reference

| Task | Command | Sudo? |
|---|---|---|
| First-time install | `sudo bash install.sh` | yes |
| Start/stop/status | `pm2 {start\|stop\|restart\|status\|logs} atlas` | no |
| Enable/disable auto-start on boot | `sudo bash StartAtBoot.sh` / `sudo bash DontStartAtBoot.sh` | yes |
| Set hostname to `openpiste` (asks first, backs up the original) | `./scripts/set-hostname.sh` | no* |
| Undo the above (or set a fresh hostname if no backup exists) | `./scripts/restore-hostname.sh` | no* |
| Install/configure Mosquitto's base listeners + chrony NTP | `./scripts/provision-broker.sh` | no* |
| Reset a lost admin PIN | `node scripts/reset_admin_pin.js` | no |
| Generate/renew HTTPS certs | `./scripts/generate-tls-cert.sh [--rotate-ca]` | no |
| Push certs to the MQTT broker | `./scripts/install-broker-cert.sh` | yes |
| Give the CMS itself a broker certificate | `./scripts/provision-cms-client-cert.sh` | no |
| Push Tier A certs/CRL to the broker (incl. after a revoke) | `./scripts/sync-mosquitto-tier-a.sh` | yes |
| Add more scoresheet pairing credentials | `node scripts/top-up-credential-pool.js [count]` | no |
| Push credential pool to the broker (incl. after a revoke) | `./scripts/sync-mosquitto-scoresheet-acl.sh` | yes |
| Check/update the OPP2 spec mirror | `./scripts/sync-spec.sh [--update]` | no |
| Wipe the database (irreversible) | `node scripts/reset_database.js` | no |
| Bundle everything a standby server needs | `./scripts/create-failover-bundle.sh` | no |
| Take over on a standby server | `./scripts/restore-failover-bundle.sh <bundle>` | no* |

\* `restore-failover-bundle.sh` itself needs no sudo, but if Mosquitto is on the same
host it shells out to `install-broker-cert.sh`/`sync-mosquitto-*.sh`, which do.
`set-hostname.sh`/`restore-hostname.sh`/`provision-broker.sh` are the same shape — the
script itself runs unprivileged, but `sudo` is invoked internally for the specific
commands that actually need it.

---

## 1. First-time install

```bash
git clone <repo> && cd AtlasCompetitionManager
sudo bash install.sh
```

Installs system packages (git, avahi, openssl, curl), Node.js 20 via NodeSource,
runs `npm ci` (build tools only if a prebuilt `better-sqlite3` binary isn't
available for this platform), creates
`data/`, runs DB migrations, creates `.env` (with a placeholder `SESSION_SECRET` you
should change before going to production), installs PM2 and configures it to start
Atlas on boot, and creates the initial `admin` account — **the one-time PIN is printed
once, at the end of this run, and never shown again.** Write it down immediately.

Safe to re-run: every step is idempotent (skips the admin account if one already
exists, skips `.env` if present, skips the credential pool if one already exists — see
§5). Re-running is the normal way to pick up a fresh `git pull`'s new dependencies.

**Also asks, interactively, whether to set this machine's hostname to `openpiste`**
(CLAUDE.md's TLS/OPP2 design assumes `openpiste.local` via mDNS) — backs up whatever
the hostname was before changing it, so it can be undone later. Skipped automatically
if `install.sh` isn't running in an interactive terminal (e.g. piped from `curl`); run
`./scripts/set-hostname.sh` by hand afterward in that case, or any time you declined it
during install. `./scripts/restore-hostname.sh` undoes it (or, if the backup's gone,
asks what hostname to set instead).

**Also asks, interactively, whether to install/configure Mosquitto's base listeners
(1883, 9001) and chrony as a local NTP server** on this machine — see §4.1. Same
skip-if-not-interactive handling as the hostname step; run `./scripts/provision-broker.sh`
by hand afterward if you skipped it or install.sh wasn't interactive.

**Also provisions the e-scoresheet credential pool** (10 credentials) and the CMS's own
Tier A broker certificate (see §5.3), and, if Mosquitto is installed on the same host,
pushes both to the broker automatically. If your broker runs on separate hardware, it
prints the manual commands instead — see §5.

**Not done by `install.sh`:** generating the HTTPS/CA certificates in the first place
(§4.2 — needed before either of the above can do anything, since both depend on
`data/tls/ca.key` already existing) and flipping listener 8883 to actually require a
Tier A certificate (`./scripts/sync-mosquitto-tier-a.sh`, §5.1/§5.3 — left manual since
it's a heavier, full-broker-restart change). Run those separately once, or whenever you
rotate the CA.

## 2. Starting, stopping, and auto-start on boot

Day-to-day process control is plain PM2, run as the app user (not root):

```bash
pm2 status              # is it running?
pm2 logs atlas          # tail logs
pm2 restart atlas       # after pulling new code / editing server.js, routes/*, services/*
pm2 stop atlas
pm2 start atlas
```

`public/`, `escoresheet/`, and other static files are served fresh on every request —
no restart needed for those. **Anything under `server.js`, `routes/`, `services/`,
`lib/` needs a `pm2 restart atlas`** to take effect; Node doesn't hot-reload those.

To control whether Atlas starts automatically on boot:

```bash
sudo bash StartAtBoot.sh      # registers a systemd unit via `pm2 startup`
sudo bash DontStartAtBoot.sh  # removes it, stops the pm2-managed process
```

## 3. Lost admin PIN

```bash
node scripts/reset_admin_pin.js
```

No arguments. If an `admin`-role user exists, resets its PIN and prints the new one
once (forced change on next login). If no admin exists at all, creates one. Safe to
run any time — it only ever touches the `admin` role, never other users.

For non-admin users (director/assistant/referee accounts), PIN resets and account
management go through the Admin → Users UI (`/admin.html`, requires an admin login),
not a script — see `docs/security-and-roles.md` for the role model.

## 4. Broker: Mosquitto, NTP, and TLS certificates

### 4.1 Mosquitto's base listeners + chrony NTP

A genuinely clean machine has neither — nothing in this repo installed Mosquitto
itself before this section existed, and every broker-touching script only ever
`command -v mosquitto`-checked and skipped if absent. Handled by one script:

```bash
./scripts/provision-broker.sh
```

No sudo itself, but shells out to it internally. Asks before doing anything, and each
piece is independently idempotent — safe to re-run, and safe to run even if the other
piece was already handled some other way:

- **Mosquitto**: installs it if missing, then creates the two listeners that never
  depend on TLS material — `1883` (plain MQTT, `docs/level2.md`'s default
  `mqtt://openpiste.local:1883`) and `9001` (plain WebSockets) — if they don't already
  exist (checks the whole of `mosquitto.conf` and `/etc/mosquitto/conf.d/*.conf`, so it
  won't duplicate or fight a hand-customized broker). Backs up `mosquitto.conf` first.
  Deliberately does **not** touch `8883`/`9002` (the TLS listeners) — those need real
  certificates first, so §4.2's `install-broker-cert.sh` creates them.
- **chrony**: installs it if missing, and adds a local-NTP-server fallback
  (`docs/level2.md` §4.3 — the broker host should also serve NTP, so devices reach it
  at the same address). Leaves the distro's default upstream `pool`/`server` lines
  untouched (real internet time is still used when available) and only adds `allow`
  for private-network ranges plus `local stratum 10`, so chrony still serves time to
  local clients with zero working upstream source — exactly the "self-contained
  competition network" case. Backs up `chrony.conf` first.

### 4.2 HTTPS / TLS certificates

Needed for the e-scoresheet PWA (service workers only register in a secure context)
and for the MQTT broker's TLS listeners (8883, 9002). Two separate scripts because the
broker may or may not be the same machine as Atlas.

**Step 1 — generate the CA + Atlas's own HTTPS certificate** (run on the machine
running Atlas):

```bash
./scripts/generate-tls-cert.sh              # reuse existing CA if present (default)
./scripts/generate-tls-cert.sh --rotate-ca  # start a brand-new CA
```

No sudo — writes only to `data/tls/` (gitignored). **Default is to reuse the existing
CA and just reissue the leaf certificate** — every device that already trusts the CA
root would need to redo that one-time install/trust step again after a rotation, which
is real friction on a competition day. Only pass `--rotate-ca` deliberately (suspected
key compromise, new season, handing the installation to someone else). After running,
`pm2 restart atlas` to pick up the new cert.

**Step 2 — push the same certs to the MQTT broker** (run on whichever machine actually
runs Mosquitto — copy `data/tls/{ca.crt,server.crt,server.key}` there first if it's not
this machine):

```bash
./scripts/install-broker-cert.sh
```

Needs sudo — first ensures the `8883`/`9002` listener stanzas exist in
`mosquitto.conf` (creating them, backing up first, if this is the first time —
`require_certificate` starts `false`; §5.1/§5.3's `sync-mosquitto-tier-a.sh` is what
later flips it to `true`), then installs the certs into `/etc/mosquitto/certs/` and
restarts Mosquitto. **Always re-run this after `--rotate-ca`** — otherwise the broker
keeps presenting a leaf signed by the now-replaced root and every device's TLS
connection to it breaks.

New device onboarding (installing the CA root so a browser stops warning) is a
self-service page, not a script: `http://openpiste.local:<PORT>/install-cert.html`.

## 5. Device pairing: Tier A (certificates) and Tier B (username/password)

Two ways a device authenticates to the broker, per `docs/level2.md` §30 — see
`docs/security-provisioning-discussion.md` for the design and
`docs/e-scoresheet-standalone-design.md` for the e-scoresheet specifically; this section
is just the operational loop. **Tier A ("device-locked credentials")** is preferred and
shown expanded by default on `/pairing.html`: the device generates its own keypair
locally and the private key never leaves it. **Tier B ("username & password")** is the
fallback for devices that structurally can't do that — browsers/PWAs, i.e. the
e-scoresheet, since a browser can't touch a platform keystore or select a client cert
from JS.

### 5.1 Tier A — pairing a scoring device

**Day-to-day pairing:** no script — `/pairing.html`'s "Device-locked credentials"
section. Pick a role (`apparatus`/`scoresheet`/`remote`/`var`), enter a label, and
you'll get a short ticket code. Type that into the device's own `/provision` page (it
has no camera to scan a QR with, unlike the e-scoresheet). The same section lists every
certificate issued so far, with a revoke button.

**Revoking:** revoking in `/pairing.html` marks it revoked in Atlas's DB and
regenerates `data/tls/ca.crl` immediately — but, same caveat as Tier B below, **this
alone does not cut the device off at the broker**:

```bash
./scripts/sync-mosquitto-tier-a.sh
```

Needs sudo. Pushes the current CRL to the broker, prunes CRL entries whose underlying
certificate has already expired on its own anyway (no security benefit to keeping them,
just unbounded growth), and — the first time it's run — flips listener 8883 to require
a client certificate. Safe to re-run any time.

**Clearing old revoked entries from the list** (cosmetic only — `/pairing.html`
showing clutter): the "Clear revoked" button in either Tier A's or Tier B's list.
Removes them from Atlas's own display; does not touch broker state or the CRL, since a
revoked certificate must stay untrusted regardless of whether it's still shown.

### 5.2 Tier B — e-scoresheet pairing

**Day-to-day pairing a device:** no script — `/pairing.html`'s "Username & password"
section, enter a label, show the QR to the new device. This only touches Atlas's own
database, not the broker.

**Topping up the pool** (when `/pairing.html` shows it running low, or none exists yet):

```bash
node scripts/top-up-credential-pool.js        # adds 10 (default)
node scripts/top-up-credential-pool.js 25     # adds a specific count
```

No sudo — only writes to Atlas's own DB. **This alone does not make new credentials
usable at the broker** — you still need the push step below.

**Pushing the pool to the broker** — required after topping up, and required after
revoking a device in `/pairing.html` (revoking there only marks it revoked in Atlas's
DB; the credential stays valid at the broker until this runs):

```bash
./scripts/sync-mosquitto-scoresheet-acl.sh
```

Needs sudo — rewrites `/etc/mosquitto/passwd` and `/etc/mosquitto/acl.conf` from
Atlas's current DB state (every non-revoked Tier B credential *and* Tier A
certificate — see §5.1), then reloads Mosquitto. Safe to re-run any time — it fully
regenerates rather than patches, so it's the same command whether you just topped up,
just revoked, or just want to confirm the broker matches the DB.

**Two things this does *not* do**, worth knowing before you assume a revoke "worked":
- An already-connected device is not force-disconnected by this — the reload only
  affects new connections. If a device must be cut off immediately, bounce Mosquitto
  itself (`sudo systemctl restart mosquitto`) or that device's specific session.
- If a paired device stops seeing live piste updates after you've confirmed it's
  connecting fine, check `docs/implementation-notes/mosquitto-security.md`'s
  documented gotcha: an authenticated device only inherits ACL rules from inside its
  own `user` block, not from unscoped global rules — this script already accounts for
  it, but if you ever hand-edit `/etc/mosquitto/acl.conf`, use `pattern` for anything
  meant to be universal, not a bare `topic` line.

### 5.3 The CMS's own broker certificate

Atlas's own OPP2 client (this server) can authenticate to the broker with a Tier A
certificate too, instead of connecting anonymously — closes a real gap where any
anonymous client on the network could otherwise spoof `software/*` messages the
apparatus is spec-required to trust unconditionally. Unlike every other Tier A device,
it doesn't need a ticket — Atlas already holds the CA's own private key locally, so it
signs its own certificate directly, in one step:

```bash
./scripts/provision-cms-client-cert.sh
```

No sudo — writes `data/tls/software-client.{key,crt}` and records the certificate in
Atlas's own DB, same bookkeeping as any other Tier A certificate. `install.sh` already
runs this automatically on a fresh install (skipped if one's already provisioned) — see
§1. If you're adding it to an *already-running* deployment instead, follow this order
to avoid a window where Atlas authenticates but temporarily loses `software/*` write
access (same "an authenticated connection inherits nothing from the old anonymous
grant" gotcha as §5.2):

1. Run the command above.
2. `./scripts/sync-mosquitto-scoresheet-acl.sh` — pushes the certificate's write grant
   *before* Atlas ever tries to use it.
3. `pm2 restart atlas` — picks up the certificate automatically; the server log shows
   `(mTLS, cert CN software-cms)` on connect (vs. `(anonymous)`) to confirm it worked.
4. `./scripts/sync-mosquitto-tier-a.sh` — only needed if listener 8883 doesn't already
   require a client certificate (i.e. no Tier A device has ever been paired here yet).

## 6. Database: backup, mid-competition failover, and reset

The database is a single file: `data/atlas.db` (plus `-wal`/`-shm` sidecar files while
the server is running). For a routine ad-hoc snapshot, no script is needed — back it up
like any SQLite file:

```bash
# Safe to copy while the server is running (WAL mode) — quick outage-free snapshot:
sqlite3 data/atlas.db ".backup data/atlas-backup-$(date +%F).db"
```

`sqlite3` (the CLI) isn't installed by default since 2026-09-03 — `install.sh` no
longer needs it (better-sqlite3, the npm package Atlas actually uses, is unrelated
to the CLI binary). Install it once if you want ad-hoc access: `sudo apt-get install
-y sqlite3`. `create-failover-bundle.sh` below checks for it itself and tells you
the same thing if it's missing.

### 6.1 Mid-competition failover to a standby server

If the primary server fails during a live competition and you need a pre-provisioned
standby to take over quickly, a plain DB backup isn't enough on its own — the standby
also needs `data/tls/` (the CA and every issued certificate) so already-paired devices
keep trusting it without re-pairing every apparatus and e-scoresheet mid-event.

**On the primary** (or its most recent backup, if the primary is already dead):

```bash
./scripts/create-failover-bundle.sh [output-path.7z]
```

No sudo. Prompts for a password twice — the archive is AES-256 encrypted (including
filenames) because it contains the CA private key; treat the resulting `.7z` file with
the same care as a key itself (no email, no unencrypted USB, delete it once the standby
has it and you've confirmed the restore worked). Bundles a live, consistent DB snapshot
(`sqlite3 .backup`, safe without stopping the server) plus all of `data/tls/`. Get the
file onto the standby however is practical in the moment (scp, USB).

**On the standby** (must already be fully provisioned — Atlas, Node, and Mosquitto
already installed with the same listener layout; there's no time for a from-scratch
`install.sh` during a live failover):

```bash
./scripts/restore-failover-bundle.sh <bundle.7z>
```

No sudo itself, but shells out to sudo-gated scripts if Mosquitto is on this same host.
Prompts for the archive password, shows the bundle's manifest (created-at/source
host/git commit) so you can confirm it's the one you think it is, then asks for
explicit confirmation before overwriting anything. Backs up the standby's *own* current
`data/atlas.db`/`data/tls/` first (as `.bak-<timestamp>`, so you can put them back if
something looks wrong), installs the restored files, re-pushes broker trust/ACL/CRL
from them if Mosquitto is local, and restarts Atlas.

Not handled by either script: getting devices to actually find the standby. If it
answers to the same `openpiste.local` mDNS name the primary used, already-paired
devices should reconnect on their own once the primary drops off the network; if the
standby has a different network identity, that's a networking step outside Atlas's own
scripts.

### 6.2 Full wipe

Only ever needed for a genuinely fresh start — e.g. resetting a demo install before a
real competition:

```bash
node scripts/reset_database.js
```

No arguments — it prompts interactively and requires typing the exact phrase
`DELETE ALL ATLAS DATA` before doing anything. **Irreversible.** Deletes the DB file and
recreates an empty schema via migrations. Does not touch `data/tls/` or any Mosquitto
config.

## 7. OPP2 spec mirror

`docs/level2.md` is a local mirror of the canonical spec at
`github.com/OpenPiste/protocols`. See CLAUDE.md's "docs/level2.md is a mirror" rule
before ever hand-editing it.

```bash
./scripts/sync-spec.sh            # diff local vs. official — read-only, no sudo
./scripts/sync-spec.sh --update   # overwrite local with the official version
```

Editing `docs/level2.md` directly in this repo only changes Atlas's own reference copy
— it does not propagate anywhere. A genuine wire-protocol change needs a PR against
`OpenPiste/protocols` (see CLAUDE.md), then `--update` here afterward to confirm the
local mirror matches what actually got merged.

## 8. Environment variables (`.env`, created by `install.sh`)

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | Plain HTTP port |
| `HTTPS_PORT` | `3443` | HTTPS port — only listens if `data/tls/server.{key,crt}` exist (§4.2) |
| `SESSION_SECRET` | placeholder | **Change this before going to production** — `install.sh` prints a generator command; not auto-generated because a fresh random value would invalidate all existing sessions on every restart if it weren't persisted |

OPP2 broker settings (URL, enable/disable) are **not** environment variables — they're
stored in the DB and configured via the `/opp2.html` admin UI, since they're meant to
be changed at runtime without a restart.

## 9. User account management

Not script-based — day-to-day account creation, role assignment, and PIN resets for
non-admin users go through `/admin.html` (Admin → Users), which requires an
admin-role login. See `docs/security-and-roles.md` for the role model
(`admin`/`director`/`assistant`/`referee`) and what each can do. §3 above covers the
one case that *is* a script: recovering when the admin account itself is locked out.

## What's deliberately *not* here

`scripts/seed_test_population.js`, `seed_sabre_fencers.js`, `seed_unicode_fencers.js`,
`enter_pool_scores.js`, and `screenshots.js` are development/testing utilities (fake
competition data, doc screenshots) — not part of running a real installation. Don't run
them against a database with real competition data in it.
