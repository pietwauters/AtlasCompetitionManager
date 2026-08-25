# Cross-platform deployment & zero-config Pi onboarding — discussion, started 2026-07-16, resumed 2026-08-23

**Status: exploratory brainstorm. Nothing designed in implementation detail, nothing
built. Non-normative — a working document, not a spec.**

## 1. The original ask

Two related questions, same thread:
- Could Atlas run natively on macOS/Windows, not just Linux/Pi? (2026-07-16)
- Could Pi deployment become "zero effort plug and go" for an organiser with no
  Linux/Pi familiarity — including WiFi setup — entirely from the browser, no SSH,
  no keyboard/monitor? (2026-08-23)

## 2. macOS/Windows native support — findings (2026-07-16)

- **App layer is portable already** (grep-verified, not assumed). Only OS-specific
  code anywhere in `services/`/`routes/`/`lib/`: `services/provisioning.js` shells out
  to the `openssl` CLI. `better-sqlite3` ships prebuilt cross-platform binaries.
- **The deployment/provisioning layer is not portable.** 9 of 11 scripts in `scripts/`
  plus `install.sh`/`update.sh` depend on Debian/Linux tooling: `apt-get`,
  `systemctl`, `hostnamectl`, `avahi`, hardcoded `/etc/mosquitto`/`/etc/hosts` paths.
- **The real blocker: mDNS on Windows**, not just a porting job. The whole TLS-trust
  design is anchored on `openpiste.local` resolving via mDNS.
  - Windows' native mDNS (since 10 1703) only serves printer/device discovery —
    general `.local` resolution needs Apple's *official* Bonjour installer (Bonjour
    Print Services standalone, or iTunes from apple.com). An iTunes copy bundled via
    the Microsoft Store can conflict with a separately-installed Bonjour and leave
    resolution half-working (confirmed via a real user support thread).
  - Windows' LLMNR fallback can create an illusion of working without Bonjour, but
    it's unreliable and often disabled by group policy on hardened networks
    (LLMNR-poisoning is a known attack vector).
  - mDNS is entirely disabled under Hyper-V virtual switches.
- **Embedded-DNS-server idea** (dnsmasq/Pi-hole pattern — authoritative for
  `openpiste.local`, transparent forwarder for everything else; hand-rolled in Node,
  not shelled out to `dnsmasq`/`bind`, since neither is native on Windows either):
  validated as directionally sound but not a simple parallel to the chrony/NTP
  precedent. Unlike NTP, a DNS client doesn't gracefully blend a secondary server — it
  needs to become the *primary* resolver.
  - **Unresolved gap:** unicast DNS needs the client to already know a server IP.
    mDNS's whole value is not needing that. If the Pi's own IP isn't fixed, a
    client's manually-configured "DNS server = x.x.x.x" setting goes stale with no
    self-healing — worse than the status quo unless addressed.
  - Practical resolution sketched, not decided: keep mDNS as the zero-config default
    everywhere it works; scope the embedded DNS server as a documented *fallback*
    only for Windows-without-Bonjour, requiring a stable server address (DHCP
    reservation or static IP) as a prerequisite.

## 3. Docker on Mac/Windows — evaluated 2026-08-23, not pursued

- Docker Desktop on Mac/Windows runs containers inside a Linux VM, so the app layer
  (Node, better-sqlite3, the `openssl` CLI) works fine inside — that part's easy.
- Two real problems:
  1. No systemd inside a container — scripts like `sync-mosquitto-tier-a.sh`
     (`systemctl restart mosquitto`) would need a different process supervisor
     (e.g. supervisord).
  2. **mDNS gets worse, not better.** Docker Desktop on Mac/Windows has no host
     networking — a container sits behind the VM's NAT, so avahi running inside it
     can't broadcast on the real LAN. The host OS still needs mDNS/Bonjour solved
     regardless of the container; Docker doesn't touch the actual blocker from §2,
     it just adds a layer on top of an already-unsolved problem.
- **Conclusion:** worth doing only if the goal becomes "no Pi at all, run on a
  laptop" — not a stepping stone toward Mac/Windows portability, since it doesn't
  reduce the mDNS design work at all.

## 4. Pre-built Raspberry Pi image — the low-risk option

- Doesn't fight the architecture: the Pi is already the target hardware (per
  CLAUDE.md's "Target hardware" line). This just packages the existing
  `install.sh`/systemd/avahi/mosquitto stack into a flashable `.img` instead of a
  script an organiser runs by hand.
- Near-zero new design risk — everything in `scripts/` already assumes exactly this
  environment; it's a packaging/distribution problem, not an architecture one.
- mDNS still works natively via avahi on the Pi itself. Windows *clients* still need
  Bonjour as in §2 — this solves server-side packaging, not Windows-side resolution.

### 4.1 Sudoers grants for privileged admin.html buttons — bake at image-build time

Raised 2026-08-24 while wiring up the first real example: admin.html's "Refresh CRL
now" button (`scripts/push-tier-a-crl.sh`) needs a passwordless-sudo grant for one
specific script before it can do anything beyond surfacing "a password is required."
On a hand-installed box, that's a one-time `sudo visudo -f /etc/sudoers.d/...` the
operator runs themselves. That doesn't fit the zero-Linux-knowledge image at all — so
how does it work there?

- **`visudo` never runs on the deployed device.** A pre-built image is assembled once
  (e.g. via `pi-gen`, or chrooting into a base Raspberry Pi OS image) under the image
  *builder's* root access, offline, non-interactively. Writing
  `/etc/sudoers.d/atlas-tier-a-crl` with the right content, `chmod 440`, and
  validating with `visudo -c` (works non-interactively too) is just another file the
  build script drops in — no different from anything else `install.sh` sets up
  today. The organiser flashes the image, boots it, and the grant is already there;
  they never see a terminal.
- **Forces a fixed user/path instead of `install.sh`'s dynamic one.** Today's grant is
  hardcoded to whatever `install.sh`'s `APP_USER=${SUDO_USER:-$USER}` resolved to at
  install time — there's no such interactive moment for a baked image to capture. An
  image needs a **fixed, known user and install path** (e.g. a dedicated `atlas`
  account, `/opt/atlas`) decided once at image-build time, not derived per-deployment.
  Real divergence between the two deployment paths this project now has, not just a
  detail.
- **Should be batched, not grown one grant at a time.** This is the natural point to
  bake in sudoers grants for every privileged script from §7's inventory (hostname,
  broker provisioning, ACL sync, this CRL push, and whatever ships next) in one pass,
  rather than remembering to add a line to the image spec every time a new admin.html
  button ships a new privileged script. Each grant stays scoped to one specific
  script — same principle as today, just applied at build time instead of by hand.
- **Real tradeoff, not free.** Baking a passwordless-root-for-one-script grant into a
  *mass-distributed* image means anyone with local/SSH access to any Pi flashed from
  it has that same path — still bounded to those specific scripts, never general
  root, but a bigger blast radius than one hand-typed line on a box built and kept by
  one person. Worth being honest about if this ever ships for real, not a blocker.

### 4.2 Forcing a real OS password on first use — piggyback on the existing admin-PIN flow

Raised 2026-08-24, directly off §4.1: if the image ships passwordless (or with a
publicly documented default), how does it stop being that way without a Linux-savvy
operator doing it by hand?

- **Real precedent, not a new idea.** Raspberry Pi OS itself has done exactly this
  since 2022 (in response to a CVE about the universal `pi:raspberry` default): a
  fresh image either needs a password pre-set via Raspberry Pi Imager's
  customization step, or refuses further use until `piwiz`/`firstrun.sh` forces a
  real one on first boot. A browser-driven equivalent for the fully-headless case is
  the same idea, not new territory.
- **Mechanism**, same shape as everything else in this doc: an OS password change is
  one root-only line — `echo "user:newpass" | sudo chpasswd`. A small dedicated
  script, a scoped `sudoers NOPASSWD` grant, baked into the image alongside §4.1's
  batch rather than invented separately.
- **The elegant part:** Atlas already has a one-time-PIN-forced-change-on-first-login
  flow for its own admin account (see "Security" in CLAUDE.md). Rather than a second,
  separate password prompt, that same first-login moment can *also* rotate the
  underlying Linux account's password behind the scenes — one prompt for the
  operator, two credentials secured (the Atlas admin login and the OS login/SSH
  credential) instead of a passwordless-or-public Linux account sitting there
  indefinitely.
- **Must be one-time and state-gated, more so than §4.1's CRL button.** That one only
  ever restarts a broker; this one changes who can log into the box at all. Only
  invocable while a "not yet hardened" flag is set, cleared the instant it's used —
  otherwise a compromised admin web session becomes a standing way to silently
  rotate the box's OS login credential too, a meaningfully bigger blast radius than
  anything else built so far.
- **Open question: same string as the Atlas PIN, or separate?** The admin PIN is
  presumably short/numeric — fine for a web login gate, weak as an SSH-facing OS
  password. Leaning toward a second field in the same first-login form ("also set
  this box's login password") rather than reusing the PIN outright, so the operator
  isn't stuck with a 4-digit SSH password without realizing it. Not decided.
- **Stronger complementary move, not yet decided either:** leave SSH itself
  *disabled* until this first-boot step completes (Raspberry Pi OS's own current
  default) rather than just racing to change the password before anyone notices —
  closes the network-reachable window entirely instead of shrinking it.

## 5. Zero-config WiFi setup from the admin UI — the new idea, 2026-08-23

Goal: an organiser with zero Linux/Pi knowledge plugs the Pi into ethernet + power,
browses to `openpiste.local`, and does everything else (admin PIN, WiFi credentials)
from the browser. No SSH, no keyboard/monitor, no `raspi-config`.

- **Why ethernet-first is the right design, not just convenience:** it sidesteps the
  classic chicken-and-egg problem (can't configure WiFi over WiFi that isn't
  configured yet). While ethernet stays connected, a WiFi profile can be added and
  tested via `nmcli` (NetworkManager — default on Raspberry Pi OS Bookworm and later)
  with zero risk of lockout: wrong credentials just mean retry over ethernet.
  NetworkManager keeps both interfaces configured with ethernet at routing priority,
  so unplugging ethernet on competition day falls back to WiFi automatically.
- **Mechanism:** a new admin.html panel (SSID, password, country) → a route →
  `execFileSync` with an argument array (never shell-interpolated, to keep
  SSID/password safe from injection) → a whitelisted script (e.g.
  `configure-wifi.sh`) → `nmcli device wifi connect ...`. This is the *same* pattern
  already in production for the CRL/hostname/broker-provisioning scripts: a
  narrowly-scoped `sudoers NOPASSWD` line per script (never a blanket
  `NOPASSWD: ALL`), invoked only from a route gated behind Atlas's existing `admin`
  role — the same PIN-login gate that already protects OPP2/MQTT config
  (CLAUDE.md's Security section). Nothing new about the trust model; this is one
  more entry on an existing whitelist.
- **WiFi country code:** can't assume it's known upfront, and a fresh Pi has its
  WiFi radio blocked (`rfkill`) until the regulatory country is set. Resolution:
  don't auto-detect and silently apply it — country code affects legal transmit
  power/channel set, so a wrong silent guess is worse than asking. Add it as one
  more field in the same setup form (a "Country" dropdown, exactly like any consumer
  router's setup wizard), optionally pre-filled from the browser's
  `Accept-Language`/`Intl` timezone as a convenience default, always user-confirmed.
- **UX principle:** no Linux vocabulary anywhere in the flow — no "regulatory
  domain," no interface names (`wlan0`), no raw `nmcli` stderr. Translate failures to
  plain language (e.g. "Couldn't connect — check the password and try again").

## 6. Combined first-boot flow (aspirational, not built)

Plug in ethernet + power → browse to `openpiste.local` → forced one-time admin PIN
change (already exists) → "Connect to WiFi" form (SSID/password/country) → unplug
ethernet. Pairs naturally with the pre-built Pi image (§4): bake NetworkManager
readiness into the image at build time so there's no first-boot `apt`/config step
before the WiFi panel is reachable.

## 7. Inventory of existing `scripts/` — which ones belong in the browser at all

Evaluated 2026-08-23 against the same "zero Linux knowledge" goal: which of the
scripts that already exist today could move into the CMS UI, rather than staying an
SSH-only step. Checked first whether any already are — grepping `routes/`/`services/`
for references to `scripts/` turns up **only comments and one user-facing error
message** (`routes/pairing.js` tells the admin to go run
`node scripts/top-up-credential-pool.js` and `scripts/sync-mosquitto-scoresheet-acl.sh`
by hand). Nothing is wired in yet — every script is still SSH-only.

**Developer-only — should never appear on any admin-facing page**, regardless of how
that page is organized: `check-architecture.sh` (code-quality gate, meaningless at
competition time), `sync-spec.sh` (upstream OpenPiste/protocols sync, dev workflow),
`dev-servers.sh` (starts local dev servers + opens Chrome — a dev-machine convenience
script, not an operational one). No organiser ever needs these.

**Operational — genuinely worth exposing**, split by fit:
- **Drop straight into an existing admin.html card, no new page:**
  `sync-mosquitto-tier-a.sh` (a "Refresh CRL now" button next to the CRL-staleness
  warning that already tells the admin to run it), `sync-mosquitto-scoresheet-acl.sh`
  (same idea next to the pairing/credential-pool card).
- **First-boot/one-time bootstrap — better as a dedicated setup-wizard page,
  sequenced:** `provision-broker.sh`, `generate-tls-cert.sh`, `install-broker-cert.sh`,
  `provision-cms-client-cert.sh`, `set-hostname.sh`. Key enabler: the CMS's own
  Express server doesn't depend on the broker or TLS existing to serve HTTP at all —
  so a first-boot wizard can sequence "admin PIN → WiFi (§5) → install broker →
  generate CA/certs" entirely from the browser, on the same
  bootstrap-before-the-thing-it-configures logic as the WiFi flow in §5. This is
  arguably the real home for the whole zero-Linux-knowledge onboarding experience,
  not just the WiFi step.
- **Needs real friction, not a plain button:** `create-failover-bundle.sh` is fine as
  a one-click "Download backup"; `restore-failover-bundle.sh` overwrites the live DB
  and the CA key and should stay behind an explicit confirmation step (or CLI-only)
  rather than a casual button.

All of the operational ones would use the mechanism already established in §5: a
per-script `sudoers NOPASSWD` whitelist entry, invoked via `execFileSync` from a route
gated behind the `admin` role.

## How to apply

Nothing here is designed in enough detail to implement yet. If resumed, the next
concrete step is designing the admin.html network-setup panel + `configure-wifi.sh`
script pair (§5), and/or the first-boot setup-wizard page that would also host the
bootstrap scripts inventoried in §7 — following the existing sudo-script precedent
(`scripts/set-hostname.sh`, `scripts/sync-mosquitto-tier-a.sh`). Related:
`docs/deployment-robustness` work (hostname/broker/NTP scripts this pattern is
modeled on), and the mDNS/TLS-trust design in `docs/e-scoresheet-standalone-design.md`.
