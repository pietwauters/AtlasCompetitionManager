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
| Reset a lost admin PIN | `node scripts/reset_admin_pin.js` | no |
| Generate/renew HTTPS certs | `./scripts/generate-tls-cert.sh [--rotate-ca]` | no |
| Push certs to the MQTT broker | `./scripts/install-broker-cert.sh` | yes |
| Add more scoresheet pairing credentials | `node scripts/top-up-credential-pool.js [count]` | no |
| Push credential pool to the broker (incl. after a revoke) | `./scripts/sync-mosquitto-scoresheet-acl.sh` | yes |
| Check/update the OPP2 spec mirror | `./scripts/sync-spec.sh [--update]` | no |
| Wipe the database (irreversible) | `node scripts/reset_database.js` | no |

---

## 1. First-time install

```bash
git clone <repo> && cd AtlasCompetitionManager
sudo bash install.sh
```

Installs system packages (Node 18+, sqlite3, build tools), runs `npm ci`, creates
`data/`, runs DB migrations, creates `.env` (with a placeholder `SESSION_SECRET` you
should change before going to production), installs PM2 and configures it to start
Atlas on boot, and creates the initial `admin` account — **the one-time PIN is printed
once, at the end of this run, and never shown again.** Write it down immediately.

Safe to re-run: every step is idempotent (skips the admin account if one already
exists, skips `.env` if present, skips the credential pool if one already exists — see
§5). Re-running is the normal way to pick up a fresh `git pull`'s new dependencies.

**Also provisions the e-scoresheet credential pool** (10 credentials) and, if Mosquitto
is installed on the same host, pushes them to the broker automatically. If your broker
runs on separate hardware, it prints the manual command instead — see §5.

**Not done by `install.sh`:** HTTPS certificates (§2) and pushing them to the broker.
Run those separately once, or whenever you rotate the CA.

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

## 4. HTTPS / TLS certificates

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

Needs sudo — installs into `/etc/mosquitto/certs/` and restarts Mosquitto. **Always
re-run this after `--rotate-ca`** — otherwise the broker keeps presenting a leaf signed
by the now-replaced root and every device's TLS connection to it breaks.

New device onboarding (installing the CA root so a browser stops warning) is a
self-service page, not a script: `http://openpiste.local:<PORT>/install-cert.html`.

## 5. E-scoresheet pairing / MQTT credential pool

The standalone e-scoresheet PWA authenticates to the broker with a unique
username/password per device, drawn from a pool. See
`docs/e-scoresheet-standalone-design.md` and `docs/security-provisioning-discussion.md`
§4.5 for the design; this section is just the operational loop.

**Day-to-day pairing a device:** no script — use the web UI at `/pairing.html`
(Admin → "Pair a scoresheet"), enter a label, show the QR to the new device. This only
touches Atlas's own database, not the broker.

**Topping up the pool** (when `/pairing.html` shows it running low, or none exists yet):

```bash
node scripts/top-up-credential-pool.js        # adds 10 (default)
node scripts/top-up-credential-pool.js 25     # adds a specific count
```

No sudo — only writes to Atlas's own DB. **This alone does not make new credentials
usable at the broker** — you still need step 2 below.

**Pushing the pool to the broker** — required after topping up, and required after
revoking a device in `/pairing.html` (revoking there only marks it revoked in Atlas's
DB; the credential stays valid at the broker until this runs):

```bash
./scripts/sync-mosquitto-scoresheet-acl.sh
```

Needs sudo — rewrites `/etc/mosquitto/passwd` and the scoresheet section of
`/etc/mosquitto/acl.conf` from Atlas's current DB state (every non-revoked credential,
whether assigned yet or not), then reloads Mosquitto. Safe to re-run any time — it
fully regenerates rather than patches, so it's the same command whether you just
topped up, just revoked, or just want to confirm the broker matches the DB.

**Two things this does *not* do**, worth knowing before you assume a revoke "worked":
- An already-connected device is not force-disconnected by this — the reload only
  affects new connections. If a device must be cut off immediately, bounce Mosquitto
  itself (`sudo systemctl restart mosquitto`) or that device's specific session.
- If a paired device stops seeing live piste updates after you've confirmed it's
  connecting fine, check `docs/implementation-notes/mosquitto-security.md`'s
  documented gotcha: an authenticated device only inherits ACL rules from inside its
  own `user` block, not from unscoped global rules — this script already accounts for
  it, but if you ever hand-edit `/etc/mosquitto/acl.conf`, don't forget the per-user
  `topic read #` line.

## 6. Database: backup and reset

The database is a single file: `data/atlas.db` (plus `-wal`/`-shm` sidecar files while
the server is running). There is no dedicated backup script — back it up like any
SQLite file:

```bash
# Safe to copy while the server is running (WAL mode) — quick outage-free snapshot:
sqlite3 data/atlas.db ".backup data/atlas-backup-$(date +%F).db"
```

**Full wipe** (only ever needed for a genuinely fresh start — e.g. resetting a demo
install before a real competition):

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
| `HTTPS_PORT` | `3443` | HTTPS port — only listens if `data/tls/server.{key,crt}` exist (§4) |
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
