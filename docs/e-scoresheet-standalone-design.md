# Standalone e-scoresheet: architecture discussion

**Status: draft for discussion. Not part of the spec.** Same spirit as
`docs/roles-and-responsibilities-discussion.md` — written to align on approach, not
just to record a decision already made after the fact. The PWA app shell, local-CA
TLS, and the shell's installability/offline behavior are now implemented and verified
on a real Android device (§3.3, §4.4) — pairing, the broker's WebSocket listener, and
any actual OPP2 client code in the PWA are still just discussed, not built.

---

## 1. The problem

Today's electronic scoresheet is `public/scoresheet.html`, rendered by Atlas and
updated over SSE. That has two drawbacks:

1. It's an Atlas-specific web view, not an independent OPP2 participant — it doesn't
   demonstrate that a scoresheet from a different vendor, on different hardware, could
   talk to the same ecosystem.
2. It depends on Atlas's own web server being reachable. If the network to the CMS goes
   down, the scoresheet goes down with it, even though the apparatus and the referee
   could otherwise keep fencing.

**Target shape, agreed:** a standalone web app that talks OPP2/MQTT directly, as its own
ecosystem participant — not a page Atlas serves and drives. Explicitly **not** a native
iOS/Android app (no app-store builds, no per-platform codebase) — it should be a
**PWA** (Progressive Web App): a normal web page with a manifest and a service worker,
installable to the home screen, capable of offline caching. Runs on both iOS and Android
from one codebase; the tradeoff is accepting each platform's own PWA quirks rather than
native APIs.

---

## 2. Transport: MQTT-over-WebSockets

**Implemented 2026-07-13.** Mosquitto already had a `wss://` listener (`9002`) —
nothing new to add on the transport side. The real gap was trust, not transport: it
presented a certificate from an unrelated, pre-existing CA (`openpiste-CA`, likely from
`mqtt-web`'s own setup), which would have meant pairing a device against *two* separate
roots — one for the PWA's HTTPS, one for the broker's WSS. Fixed with
`scripts/install-broker-cert.sh`, a new script that installs Atlas's own CA-signed
certificate into Mosquitto's TLS listeners (`8883`, `9002`) instead. It's deliberately
location-agnostic — it operates on whatever machine it's run on, so it works unchanged
whether the broker is co-located with Atlas or on separate hardware (copy `data/tls/`
there first, then run it there). This only makes sense because the broker is assumed to
be under the same operator's control as the CMS, even if on different hardware — a
broker genuinely run by an unrelated third party would keep its own separate root, and
pairing would need to trust both, which doesn't contradict the "no single shared
ecosystem-wide root" decision in §3.2, it's the same principle applied to another
component. Verified: both listeners now show `issuer=CN = Atlas Local CA`, `openssl
s_client ... -CAfile data/tls/ca.crt` returns `Verify return code: 0 (ok)`, and Atlas's
own OPP2 client (plain `mqtt://openpiste.local:1883`, untouched) reconnected cleanly
after the broker restart.

**Not yet done:** no OPP2/MQTT client code exists in the PWA itself yet — the listener
is reachable and correctly trusted, but nothing in `escoresheet/js/app.js` connects to
it.

Atlas's own OPP2 client (`lib/opp2Client.js`) and the ESP32 apparatus firmware both use
plain TCP MQTT on port 1883 — CLAUDE.md's transport section notes "not WebSockets —
those are for browsers." That line was correct for what existed at the time; it doesn't
preclude a browser client, it just means one hasn't been added yet.

**Browser JavaScript cannot open a raw TCP socket at all** — this is a sandboxing
property of the web platform, not an Atlas or broker choice. A browser-based OPP2
participant is therefore structurally required to speak **MQTT-over-WebSockets**. This
is additive on the broker side: Mosquitto (and virtually every other broker) supports
multiple concurrent listeners on the same broker — e.g. 1883 for plain TCP alongside a
second listener (e.g. 9001) for WebSockets, same topics, same retained state. No change
needed to Atlas's own backend client or the apparatus firmware.

---

## 3. The TLS trust problem

### 3.1 Why it's unavoidable

A PWA's service worker (the thing that makes offline operation possible at all) only
registers in a **secure context** — HTTPS, or `localhost`. Browsers also block a page
loaded over `https://` from opening a plain `ws://` connection (mixed-content). So the
broker's WebSocket listener needs TLS (`wss://`), and that means **some** certificate
trust decision has to be made — there is no way to keep the PWA's offline capability
and skip TLS.

A second, harder constraint: **browser JavaScript has no API to inspect or pin the TLS
certificate a server presents.** For `https://`/`wss://`, the browser's own TLS stack
accepts or rejects the connection before any page code runs. A QR code, a fetched JSON
blob, anything from JS — none of it can make the browser retroactively trust an
unrecognized certificate. Native apps can do real certificate pinning via platform APIs;
a PWA cannot. This shapes everything below.

### 3.2 Options considered and rejected

- **A single shared root CA across the whole OpenPiste ecosystem**, baked into every
  vendor's PWA at build time. Rejected: needs a governing body to mint and safeguard a
  shared private key, and a single leak compromises trust for every vendor's install
  everywhere — too much cross-vendor governance for the actual problem.
- **Public IP-embedding certificate services** (the `plex.direct` / `sslip.io` pattern:
  a hostname like `192-168-1-5.sslip.io` that a public DNS server parses and returns as
  the literal embedded IP, fronted by a real, publicly-trusted wildcard cert). Real,
  proven prior art (Plex, Ubiquiti's `*.ui.direct`) — but the free/shared services only
  work because they **publish their wildcard certificate's private key openly**, which
  means anyone can present a valid-looking cert for that domain. That's weaker than a
  private CA on the "prove this is really the CMS" axis, even if it still defeats casual
  eavesdropping.
- **The same trick with Atlas's own domain** (`openpiste.org`), own private key, via a
  Let's Encrypt cert (DNS-01 challenge — no inbound reachability needed) plus either a
  fixed/reserved LAN IP or a live DNS-update/lookup mechanism. Rejected for the same
  reason as the plain DDNS idea below: it reintroduces a live-internet dependency that
  conflicts with Atlas's own principle that local operation must work with **zero**
  internet, and it implicitly assumes a fixed or trackable IP, which can't be guaranteed
  across whatever router shows up at a given venue.

### 3.3 Chosen approach: per-install self-signed local CA + mDNS identity

Each CMS install (any vendor, not just Atlas) generates its own root CA key — no shared
key, no cross-vendor governance, no external dependency. **It's fine to regenerate the
root per competition** if that's operationally simpler than long-term key custody.

The CMS's own server certificate is issued for **`openpiste.local`** — the existing
mDNS hostname Atlas already uses for broker discovery (`mqtt://openpiste.local:1883`
today). This is the key move that resolves the fixed-IP question raised during this
discussion: mDNS resolution is multicast-based and re-resolves to whatever IP a given
venue's DHCP handed out that day, on any subnet, with zero configuration and zero
internet dependency. A certificate's validity is about the **name** matching and the
chain of trust, not about the IP behind it — so binding the cert to `openpiste.local`
instead of an IP address makes the whole TLS setup completely indifferent to DHCP,
subnet, or router choice. This is strictly better here than the IP-embedding or DDNS
approaches, which exist specifically to solve a fixed-IP problem that mDNS was already
solving for free.

**Implemented 2026-07-13.** `./scripts/generate-tls-cert.sh` generates the local CA and
the `openpiste.local` leaf certificate into `data/tls/` (gitignored, same convention as
`data/atlas.db`) — `--reuse-ca` keeps an existing root and only reissues the leaf; the
default is a fresh CA + leaf each run, matching "fine to regenerate per competition."
`server.js` starts a second, additive HTTPS listener (`HTTPS_PORT`, default 3443)
alongside the existing HTTP one, on the same Express `app` — every existing route,
including `/escoresheet`, is now reachable over both; nothing about the current
HTTP-based workflows changes. If `data/tls/server.{key,crt}` don't exist yet, the HTTPS
listener is skipped with a log line pointing at the script, so this is a no-op for
anyone who hasn't run it. Verified end-to-end: `openssl verify` confirms the leaf chains
to the generated CA, and `curl --cacert data/tls/ca.crt
https://openpiste.local:3443/escoresheet/` returns 200 with full chain validation (no
`-k`), both via `localhost` and via the real mDNS hostname.

**Deployment gotcha found during real-device testing, not specific to Atlas's own
code:** on a dev machine with Docker installed, `avahi-daemon` advertised
`openpiste.local`'s IPv4 address as the Docker bridge (`docker0`, `172.17.0.1`) rather
than the real LAN interface — unreachable from any other device. Fixed with
`deny-interfaces=docker0` in `/etc/avahi/avahi-daemon.conf` (deliberately not
`allow-interfaces=<name>`, which would hardcode today's WiFi interface and silently
break mDNS if the same machine were plugged into Ethernet at a venue instead). Worth
checking on any machine that runs both Atlas and Docker.

**Not yet done:** the broker's MQTT-over-WebSockets listener (§2) doesn't exist yet —
this step only covers serving the PWA's own app shell over a secure context, which is
what a real device needs before its service worker will even register. The PWA has no
OPP2/MQTT client code at all yet, so there's nothing to point at a broker for.

---

## 4. Trust bootstrap and pairing

### 4.1 Precedent: `mqtt-web`'s ESP32 enrolment flow

`~/mqtt-web/enrolment.js` already implements a local-CA pairing flow for ESP32 scoring
devices, and is the direct inspiration here (adapt, don't copy verbatim):

- A local CA (`ca.crt` + a `sign-device-cert.sh` signing script) already exists and
  runs in production for this purpose.
- `POST /pairing/enable` is restricted to `127.0.0.1` and opens a 2-minute pairing
  window — the real access control is the time-boxed window, not the cryptography.
- The device calls `POST /pair/start` with a self-chosen `deviceId`, gets back a random
  challenge; it generates its own keypair locally (never transmits the private key),
  builds a CSR, and submits `POST /enrol` with an HMAC of the challenge — the CMS
  verifies, signs the CSR, and returns both the signed device cert and the CA root cert.
- Single global pairing slot, cleared after one successful enrolment.

### 4.2 Weaknesses when adapted as-is for scoresheet pairing

1. **Localhost-only gating breaks for a mobile operator.** The operator wants to walk
   strip to strip pairing scoresheets from their own phone/tablet, not stand at the CMS.
2. **Naively opening `/pairing/enable` to the LAN removes the only real access control**
   without replacing it — anyone else on the venue network could enable pairing too.
3. **Single global pairing slot is a race condition**, not just a single-device
   convenience: whoever hits `/pair/start` first during the window wins it, regardless
   of which physical device the operator intended to pair. Two staff pairing at once, or
   an automated actor on the LAN, can exploit this.
4. **No human-verified match between "the device in front of me" and "the device that
   enrolled."** Bluetooth/WPS-style pairing always has a moment where a human confirms a
   code on both ends specifically to catch this; this flow has none.
5. **The CSR/HMAC exchange defends against less than it looks like** for this threat
   model — the "secret" (the challenge) travels over the same not-yet-trusted channel as
   everything else, so it mainly stops passive replay, not an active on-path attacker.
   Given the stated bar ("not bank-grade; TLS + network access control should make
   tampering extremely difficult," not eliminate every conceivable LAN attacker), this
   is real but acceptable machinery for an ESP32 — not necessarily worth its complexity
   for a human-operated pairing flow (see 4.3).
6. **CSR generation needs a crypto library in the browser** — there's no native browser
   API to build a PKCS#10 CSR. Real added implementation weight for something a simpler
   mechanism (4.3) can avoid entirely.

### 4.3 Improvements adopted for this design

- **Reuse Atlas's existing authenticated session, not a new IP check.** Atlas already
  has QR+PIN login for Director/Admin roles (`docs/security-and-roles.md`) — "enable
  pairing" should be a normal role-gated route reachable from the operator's own device
  anywhere on the LAN, not a new access-control mechanism. This also fits Atlas's
  existing access matrix, which already lists "Electronic scoresheet (future)" as a
  Referee/Director/Admin capability.
- **PIN-based, per-attempt pairing tickets instead of a global slot.** The operator taps
  "pair a device," the CMS generates one short-lived, single-use numeric code, and the
  operator relays it to the specific scoresheet being paired (typed in, or shown/scanned
  — QR codes are already a first-class UX pattern in Atlas via accreditation badges).
  This removes the race condition (4.2 #3) and adds the missing human-verification step
  (4.2 #4) for free — the operator is physically choosing which device gets which code.
- **Issue a bearer token, not a client certificate.** The browser only needs to (a)
  trust the CMS's server cert — solved once via `openpiste.local` (§3.3) — and (b) prove
  it was legitimately paired. A simple per-device token issued over the now-PIN-verified
  channel does that without any in-browser CSR/crypto library, and makes revocation
  trivial (invalidate the token; no CRL/cert-revocation machinery needed).
- **One hands-on moment preserved, not eliminated.** The operator does a single
  hands-on trust bootstrap for *their own* device at (or near) the CMS — mirroring the
  spirit of the original localhost restriction — and every other scoresheet is then
  paired remotely via a walked-around PIN, no further hands-on-server moments required.

**Implemented 2026-07-13.** Migration `027_scoresheet_pairing.sql` adds
`pairing_tickets` (short-lived, single-use, 6-digit codes, 5-minute default TTL) and
`paired_devices` (bearer-token holders, revocable). `services/pairing.js` —
`createTicket`/`redeemTicket`/`listDevices`/`revokeDevice`/`verifyToken`; ticket codes
aren't DB-uniqued forever, just checked against currently-live tickets at creation time,
since codes are meant to be reused across a competition's lifetime, not permanently
reserved. Two route files, deliberately separated by trust level: `routes/pairing.js`
(mounted `/api/pairing`, `auth.require('director')` on everything — ticket creation,
device list, revoke, and a QR-code endpoint for the ticket) and `routes/pair.js`
(mounted `/api/pair`, no auth at all — the device-facing `redeem` endpoint, since the
device has no Atlas session to present). `public/pairing.html` is the operator UI
(code + QR + countdown + device list with revoke), linked from `opp2.html`'s nav.
`escoresheet/`'s pairing form now actually calls `/api/pair/redeem`, generates and
persists its own `deviceId` (`crypto.randomUUID()`, localStorage) the first time it
runs, and stores the returned token — same-origin `fetch` is assumed (the PWA and
Atlas's API share one origin in this reference deployment, so no CMS-address field was
built; a genuinely third-party scoresheet would need one).

**A real routing bug found and fixed during testing, not a design flaw:** the
pre-existing `app.use('/api', writeOnly('director'), require('./routes/teamMatches'))`
in `server.js` matches *any* path starting with `/api`, including the new
`/api/pair/redeem` — since it was registered before the new routes, it was silently
gating the public redeem endpoint too (a mutation, so `writeOnly` applied full auth to
it). Fixed by registering `/api/pairing` and `/api/pair` before that catch-all.
General lesson for this codebase: a bare `app.use('/api', ...)` mount is a trap for
anything registered after it — worth checking route order whenever a new `/api/*`
path is added.

Verified end-to-end over real HTTP (not just at the service layer): ticket creation →
redeem → `verifyToken` resolves → a second redeem attempt on the same code is rejected
→ revoke → `verifyToken` stops resolving. Confirmed `/api/pair/redeem` returns 403 for
a bad code (not 401 — proving it's genuinely unauthenticated) and `/api/pairing/*`
correctly returns 401 with no session.

**Verified fully end-to-end on real devices, 2026-07-13.** QR-scan pairing was tried on
a real second phone: scanning the ticket QR opened the e-scoresheet with the code
pre-filled, and completing "Pair" showed the paired state and appeared correctly in
`pairing.html`'s device list.

**Real bug found along the way, not a design flaw:** after adding the QR route to
`routes/pairing.js`, the QR image was a broken/missing icon in the browser. Root cause:
the running server process predated that file edit — Node doesn't hot-reload route
files, so the live process was still serving the *old* `routes/pairing.js` with no `/qr`
route at all (`Cannot GET .../qr`, a genuine Express 404, confirmed via a throwaway test
director account + curl rather than guessing). **General lesson for this whole
session's iteration style: any edit to `server.js`/`routes/*.js`/`services/*.js` needs a
server restart before it's real — unlike `public/`/`escoresheet/` static files, which
`express.static` serves fresh from disk on every request with no restart needed.**

**Friction raised after this worked, 2026-07-13: installing the CA root on a new device
is real, multi-step, per-OS friction** (§4.4) — unavoidable in full (no browser API lets
a page silently install a trust anchor, by design), but two concrete things cut it down:

1. **`GET /ca.crt`** (`server.js`) — a permanent, public, plain-HTTP route serving
   `data/tls/ca.crt` directly (`application/x-x509-ca-cert`), replacing the ad hoc
   "temporarily copy it into `public/`" workaround used during earlier testing.
   Deliberately plain HTTP, not HTTPS: a brand-new device has no reason yet to trust the
   very certificate this CA signs, so the download can't depend on that trust already
   existing.
2. **`public/install-cert.html`** — a dedicated, unauthenticated onboarding page:
   QR + direct link to `/ca.crt` (`GET /api/pair/ca-qr` generates the QR, same
   `qrcode` library as the ticket QR), with per-platform instructions
   (Android/iOS/desktop Chrome/Firefox) shown via simple user-agent detection so nobody
   has to read all four. Linked from `pairing.html` as the first step for a new device.

**Also revisited: `generate-tls-cert.sh`'s default flipped from "fresh CA every run" to
"reuse the existing CA unless `--rotate-ca` is passed."** Prompted directly by this
friction — rotating the root means every already-onboarded device has to redo the
one-time OS-level install dance again, for every single competition, which is real cost
on a competition day, not a one-off. Reusing the same root across as many competitions
as an installation runs means each device only ever does this once, full stop. Rotate
deliberately (suspected compromise, a new season, handing the installation to someone
else), not by default. `--reuse-ca` (the old opt-in flag) removed as redundant now that
it's the default. Note added to the script: after a `--rotate-ca`, `install-broker-cert.sh`
must be re-run too, or the broker keeps presenting a leaf signed by the now-replaced root.

### 4.4 Resolved 2026-07-13 (Android) — real-device test

**Tested end-to-end on a real Android phone (Chrome), on the actual local WiFi, against
this Atlas install.** Sequence: plain HTTP to `/escoresheet/` (reachability check) →
HTTPS before installing the CA (correctly showed the standard untrusted-certificate
warning — the expected "no pairing yet" baseline) → downloaded `data/tls/ca.crt` over
the existing HTTP port and installed it via Android's certificate-install flow (Settings
search → "certificate" → CA certificate; the file-tap-to-install shortcut also works) →
revisited over HTTPS: **no warning at all**, service worker registered and active →
Add to Home Screen → relaunched from the home-screen icon.

**Finding: once the manifest, service worker, and certificate are all valid, Chrome on
Android launches a genuine standalone PWA — no address bar, no tabs — exactly as
`display: standalone` specifies.** The CA-profile-install path (not a bare click-through)
is confirmed as necessary and sufficient on this platform.

One real wrinkle hit and resolved during testing, worth keeping in mind for the actual
pairing UX later: the *first* "Add to Home Screen" attempt produced a plain bookmark
shortcut (opened in a normal browser tab/address bar) rather than a true install — this
happened because Chrome only offers a genuine "Install app" once it's satisfied the
installability criteria are met at that moment, and the attempt was made before that had
fully settled. Removing the stale shortcut and retrying fresh produced the correct
standalone install. **Implication for the real pairing flow:** whatever UI eventually
walks a referee through pairing should prompt "Add to Home Screen" only *after*
confirming the service worker is active and the connection is warning-free — not
immediately on first load — or risk the same silent bookmark-not-install failure mode.

**Still unverified: iOS Safari.** iOS's installability/profile-trust mechanics
(`.mobileconfig` install + the separate "enable full trust" toggle under Certificate
Trust Settings) are structurally different from Android's flow and have not been tested
hands-on. Should not be assumed to behave the same way.

---

### 4.5 Live piste display — implemented 2026-07-13

The first genuine OPP2 client code in the PWA. Deliberately scoped to the **display**
role only (§2.3) — subscribes and mirrors, never publishes. `escoresheet/index.html`
gained a piste picker ("Watch this piste") and a live scoreboard; `escoresheet/js/app.js`
uses `mqtt.js` (loaded via CDN — `https://unpkg.com/mqtt@5/dist/mqtt.min.js`, the
browser build of the same `mqtt` npm package Atlas's own backend already depends on) to
connect to `wss://{location.hostname}:9002` and subscribe to:

- `apparatus/connection` — online/offline badge
- `apparatus/fencers` — fencer names. Deliberately **not** also tracking
  `software/fencers` — since `apparatus/fencers` is retained and the apparatus always
  republishes it (confirming a fresh `software/fencers`, or its own last-known state on
  reconnect, per §15), a passive read-only display gets the current correct assignment
  from that single retained topic alone, with no need to replicate the CMS's own
  empty/identical/swap/anomaly reconciliation logic — that logic is for a party that has
  to *decide* something; this one only *shows* whatever's already been decided.
- `apparatus/score` — score, cards (rendered as coloured chips), priority
- `apparatus/clock` — formatted time string
- `software/match` — weapon/phase/match number (not retained, so a fresh subscriber
  sees "unknown" until the next change — expected per §2.5, not a bug)

No MQTT username/password or the pairing bearer token is used for this connection — the
broker's listeners are `allow_anonymous true`, matching how the apparatus and other OPP2
participants already connect, and matching the ecosystem-openness principle (any
compliant scoresheet can subscribe with no bespoke auth). The pairing token remains
issued-but-unconsumed for now — it was built for a future scoresheet-facing Atlas REST
API, not for broker authentication, and nothing has needed it yet.

**Verified without a real browser**, using Node's own `mqtt` client (same library
family — `mqtt.js`'s browser build is literally that package's browser bundle) to replay
the *exact* subscribe flow `app.js` uses against `wss://localhost:9002` with
`data/tls/ca.crt`, while a second connection published test payloads for all five
message types via the plain `mqtt://localhost:1883` listener. All five arrived with
topics parsing exactly as `app.js`'s routing logic expects — confirms the transport,
TLS, and topic-parsing logic end-to-end.

**Confirmed for real 2026-07-13 on a real device against a real, live piste** (not
simulated data) — connected the paired Android phone to an actual in-progress piste and
watched fencer names, score, cards, and clock render correctly in real time. This closes
the one gap the Node-only test above couldn't reach (actual DOM rendering/CSS in a real
browser) and, unlike the earlier simulated-data test, exercises a genuine apparatus as
the publisher rather than a script standing in for one.

---

## 5. What this leaves open

**Done:** the PWA app shell (`escoresheet/` — manifest, service worker, install/online
status page) and the local-CA/HTTPS serving of it (§3.3) both exist and are verified as
far as `curl`/`openssl` can verify them, plus real-device confirmation (§4.4, Android).
The broker's trusted `wss://` listener (§2) and the pairing-ticket flow (§4.3) are both
now implemented and verified over real HTTP/at the service layer (§4.3's "Implemented"
note) — not yet walked through on a real second device.

- §4.4's empirical platform question — still Android-only, iOS untested.
- A real phone-to-phone pairing walkthrough (operator's own device issuing a ticket,
  a second real device redeeming it) — everything so far is curl/service-layer verified,
  not human-verified end to end.
- The three older sub-problems from the scoresheet-authority discussion, still not
  covered here: offline bundle/pre-round export (so a scoresheet can run blind without
  a live `software/fencers` push), local enforcement of the §23.4 correct-ending rule
  when the CMS is unreachable, and stale-replay reconciliation on reconnect.
- ~~Whether the broker's WebSocket listener needs its own config/`bout_duration_standards`-
  style admin surface, or just a static Mosquitto config change.~~ Resolved (§2): a
  static Mosquitto config change (already existed) plus a one-time cert-unification
  script — no new admin surface needed.
- ~~Actual OPP2/MQTT client code in the PWA — nothing connects to the (now correctly
  trusted) broker listener yet.~~ Resolved (§4.5): live piste display (fencers, score,
  cards, priority, clock, connection status) — read-only.
- ~~Real-browser confirmation of §4.5's live display (rendering/CSS, not just the
  underlying MQTT plumbing).~~ Resolved (§4.5): confirmed on a real Android phone
  against a real, live, in-progress piste — not just simulated data.
- ~~Any scoresheet-side *publishing* — annotations/card reasons (`scoresheet/event`,
  `scoresheet/record`), which is the next logical layer beyond a read-only display.~~
  Resolved (§4.6).

### 4.6 Card-reason recording — implemented 2026-07-13

The first *publishing* feature in the PWA — everything before this was read-only
display. Ported from the existing `public/scoresheet.html` (Atlas's own
Alpine.js/Paho-based scoresheet, which already implements this exact feature over the
legacy plain `ws://:9001` listener) rather than designed from scratch: same card
detection logic, same reason data source (`/data/reasons.json` — already served by
Atlas, same origin, no CORS issue), same dialog flow (reason grid, "Repeated Group 1"
drilldown, free-text fallback, official picker, skip). Rewritten as vanilla JS/DOM
(the PWA has no Alpine.js dependency, deliberately — see §1) and `mqtt.js`/`wss://`
instead of Paho/plain `ws://`.

**No new server-side code was needed.** `lib/opp2Client.js` already subscribes to
`openpiste/+/scoresheet/event` and persists `CARD_REASON` annotations via
`services/cardReasons.js` — this was built for the existing Atlas-hosted scoresheet
and works identically for any compliant publisher, including this one. This is the
OPP2 ecosystem-independence principle actually paying off: the CMS-side handler never
needed to know or care which scoresheet implementation published the event.

New in `escoresheet/js/app.js`:
- Subscribes additionally to `software/record` (slot_id, active_bout, officiating
  roster) and `scoresheet/record` (retained annotation history, for reconnect).
- `detectCards()` diffs successive `apparatus/score` payloads per side
  (yellow_card false→true, red_cards increase, black_card false→true) and opens the
  reason dialog — skipping the very first score received after connecting, so
  reconnecting to a piste that already has a card showing doesn't trigger a false
  popup.
- The dialog: card badge, fencer name, an official picker (referee/referee2/assessor1/
  assessor2 — shown only when more than one is assigned, silent default otherwise,
  matching the existing officiating-roster UX convention in CLAUDE.md), a reason grid
  filtered by card type + weapon + drilldown step, free-text fallback, and skip.
- `publishCardReason()` → `scoresheet/event` (fire-and-forget, per annotation).
- `publishAnnotationRecord()` → `scoresheet/record` (retained, full accumulated list,
  republished after every new annotation).
- `handleSoftwareRecord()` implements §17/§18's slot-change semantics: a new
  `slot_id` clears the annotation list and republishes an empty `scoresheet/record`;
  the same `slot_id` just updates `active_bout`/officials, keeping history.
- `handleScoresheetRecord()` implements the reconnect-restore path: a retained
  `scoresheet/record` whose `slot_id` matches the current one repopulates
  `annotations` from it.

**Known imperfection, not yet fixed:** per spec, `scoresheet/record`'s
`annotations[].bout_id` is *mandatory*, but `scoresheet/event`'s is *optional*
("absent if not bout-specific"). If a card is somehow detected before any
`software/record` has been received (so `activeBoutId` is still unset — possible if
`apparatus/score` is retained-and-immediately-available but the CMS hasn't published
the slot assignment yet), the resulting `scoresheet/record` entry would carry
`bout_id: null` rather than a real integer or being omitted. Not fixed this session —
noted here rather than silently left unnoticed.

**Tested on a real device — one real bug found and fixed.** The reason dialog opened
correctly on a real card, but wouldn't dismiss — Skip, submitting a reason, nothing
closed it. Root cause was CSS, not the dialog logic: `.overlay` set `display: flex`
unconditionally, and that *author* stylesheet rule outranks the browser's own built-in
`[hidden] { display: none }` *user-agent* rule regardless of specificity — author
rules beat user-agent rules in the cascade by origin alone. So the JS was correctly
setting `hidden = true` and nulling the dialog state the whole time; the CSS just kept
showing it anyway. Fixed by scoping the flex display to `.overlay:not([hidden])`
(`escoresheet/css/app.css`) instead of applying it unconditionally — confirmed fixed on
a real device afterward, including a full reload to verify the service worker's
`skipWaiting()`/`clients.claim()` actually picks up the new CSS rather than serving a
stale cached copy. **General lesson for the rest of this app:** any element toggled via
the `hidden` attribute must never have its own class set an unconditional `display`
value — checked every other `hidden`-toggled element in this stylesheet (`.card`,
`.error`, `.back-btn`, `.official-picker`) and none of the others set `display` at all,
so this was an isolated case, not a systemic one.

### 4.7 Full feature parity with `public/scoresheet.html` — implemented 2026-07-13

Everything before this showed only the single active bout. This pass ports the rest of
`public/scoresheet.html`'s functionality — same algorithms, same data shapes, rewritten
vanilla-JS/`mqtt.js` instead of Alpine/Paho:

- **Full bout list**, not just the active one — every bout in the current slot,
  collapsible, sourced from `software/record`'s `bouts[]`. The active, unfinished bout
  shows a "LIVE" badge and auto-expands to the live scoreboard (fencer names, score,
  cards, clock, priority — the same fixed-id markup from §4.5/§4.6, now generated
  dynamically per-render rather than living statically in the page, so it can appear
  inside whichever bout row is currently active). Other bouts show their final result
  once confirmed, or a placeholder beforehand. Any bout can be manually
  expanded/collapsed (event delegation on the list container, since rows are
  regenerated via `innerHTML` on every structural change).
- **Pool results matrix** (`computeMatrix()`/`renderMatrix()`) — identical
  participants × participants grid, V/M, indicator (TS − TR), and ranking algorithm
  (sort by V/M, then indicator, then TS) ported line-for-line from
  `scoresheet.html`'s `matrix` getter. Shown only when `phase_type === 'pool'` and
  `participants` is present.
- **Team relay banner** — relay number/total, team names, cumulative score, target,
  shown when `software/match`'s `type === 'T'`. These fields (`relay`, `relay_total`,
  `left_team`, `right_team`, `left_cumul`, `right_cumul`, `target`) are Atlas-specific
  extensions to `software/match`, not core `docs/level2.md` §16 fields — handled
  defensively (all optional, same as the reference implementation), not validated
  against the spec since they aren't part of it.
- **Slot info line** — label + officiating roster names, from `software/record`.
- **Manual theme toggle** — `:root[data-theme="dark"|"light"]` CSS overrides added
  alongside the existing `prefers-color-scheme` media query (mirrors Atlas's own
  `nav.js` pattern: explicit choice always wins over the system default, in both
  directions), persisted to `localStorage`.

**A real, structural correctness detail carried over deliberately:** on an
active-bout change (new bout becomes active, whether via a slot change or the same
slot advancing), `lastScoreForCards`/`lastFencers`/`lastClock` are all reset to `null`.
Without this, a card-detection diff could compare the *new* bout's first real score
against the *previous* bout's final card state, causing spurious or missed dialog
triggers — this exact reset is why `scoresheet.html` does it, ported deliberately
rather than dropped as unnecessary-looking boilerplate.

**Verified:** every `getElementById`/`setText` target cross-checked against the actual
HTML (two expected "misses" — `left-cards`/`right-cards`, which only ever exist inside
the dynamically-generated live scoreboard markup and are correctly null-guarded); a
fuller Node-simulated `software/record` (3 participants, 3 bouts including one
finished result) + `software/match` sequence over the real `wss://` listener, confirming
the richer payload shape parses correctly end-to-end. **Tested on a real device — one real bug found and fixed.** Everything worked except
the pool matrix, which never appeared. Root cause: `#matrix-section` (the outer
container — header button + table) was correctly toggled visible by `renderMatrix()`,
but the inner `#matrix-wrap` (the actual table) started with a static `hidden`
attribute in the HTML that `renderMatrix()` never cleared — only the manual
toggle-button click handler ever touched it. So the table stayed collapsed by default,
unlike `scoresheet.html`'s Alpine state (`matrixOpen: true`), which starts expanded.
Fixed by removing the static `hidden` from `#matrix-wrap` and giving `#matrix-arrow`
the `open` class by default, so both markup and toggle-button logic agree on
"expanded by default." Confirmed fixed on a real device afterward. Bout list, team
relay banner, slot info, and theme toggle all worked correctly on first real-device
try, no fixes needed for those.

**Second real-device finding, same session: layout, not a bug in the strict sense.**
`main` was capped at `max-width: 480px` — reasonable for the original single-bout
phone view, wasteful once the live view holds a data table (pool matrix) and a list.
Fixed with a `min-width: 700px` media query: `main` widens to 900px, while the
pairing/status cards (simple forms) explicitly stay capped at 480px and centered —
phones below the breakpoint are unaffected. Mirrors this codebase's existing
width-driven (not orientation-driven) responsive principle (CLAUDE.md's frontend
layout section), just implemented locally here rather than via the shared
`public/css/style.css` classes, since this app deliberately doesn't depend on that
file.

### 4.8 Tracked gap: no per-piste/role scoping once paired — raised 2026-07-13

**Confirmed by re-reading the actual code, not assumed:** once a device is paired, it
can watch or publish annotations for *any* piste, with no restriction — and this isn't
unique to a paired device either. `services/pairing.js`'s `verifyToken()` is never
called anywhere; `watchPiste()`'s `mqtt.connect()` sends no credentials at all; every
Mosquitto listener has `allow_anonymous true`. So *any* device that can reach the
broker — paired through this flow or not — can subscribe or publish to any piste's
topics. This isn't a regression introduced this session — it's the same trust model
every other OPP2 component here already operates under (the apparatus firmware,
Atlas's own backend) — but it's a real, undesigned gap for the specific case of "should
a paired scoresheet only ever touch the piste it was paired for."

**Not fixed — tracked as a real TODO, not implemented.** Actually closing it needs more
than a config tweak: assigning each paired device a genuine MQTT identity (username/
password, or a per-device client certificate) at pairing time — not just the current
opaque application-level bearer token, which Mosquitto has no way to check — plus ACL
rules (or a dynamic auth plugin) mapping that identity to the specific piste(s) it's
allowed to touch.

**What Mosquitto can actually enforce, at what granularity, laid out for the follow-up
decision** (`allow_anonymous`/`require_certificate` are per-*listener*, not just
broker-wide — already used differently across `1883`/`8883`/`9001`/`9002` in this
setup):

- **Authentication (who may connect at all)** — three options, combinable per
  listener: anonymous (today's setting, everywhere); username/password
  (`password_file`); client certificates (`require_certificate true` — true mTLS, the
  cert itself is the identity, can double as the MQTT username via
  `use_identity_as_username`).
- **Authorization (`acl_file`) — genuinely separate from authentication, and genuinely
  separate per action.** Rules are per-topic-pattern *and* per-direction (`read` /
  `write` / `readwrite`), e.g. `topic write openpiste/17/scoresheet/#` grants publish
  to piste 17's scoresheet topics only, independent of whatever else that identity can
  read. Patterns support `%u` (username) and `%c` (client id) substitution — e.g.
  `topic write openpiste/%u/scoresheet/#` would let a device publish *only* to
  whichever piste number is embedded in its own username, which is the natural
  mechanism for "this pairing ticket was scoped to piste 7" if pairing issued
  per-device MQTT credentials naming the piste.
- **These two axes are independent** — read can stay wide open (anonymous, matching
  "everyone on the network can subscribe to anything" from the discussion that raised
  this) while write is authenticated and ACL-scoped, on the *same* listener, with no
  contradiction.
- **TLS-or-not per device class isn't something the broker can detect** (it can't tell
  a phone from an ESP32) — it's enforced by *convention*: which listener a given class
  of client is configured/documented to use. Today's split (`1883` plain for the
  apparatus firmware, `9002` TLS for the PWA) already does this; formalizing "TLS
  recommended for phones/tablets, optional for embedded scoring devices" just means
  keeping that split deliberate rather than incidental.

**Partially implemented, 2026-07-13 — "Option 1" (any paired device may publish to any
piste's `scoresheet/*`, but only a paired device at all):** `scripts/setup-mosquitto-auth.sh`
(one-time, provisions a single shared Mosquitto user + ACL — read stays universally
open, `apparatus/software/remote/var` writes stay anonymous/unchanged, only
`scoresheet/*` writes require the shared credential); `routes/pair.js` hands that
credential to any device that redeems a valid pairing code; `escoresheet/js/app.js`
stores and uses it. **Code written, not yet run/verified** — the setup script needs to
actually be executed (sudo-gated, same as the earlier TLS/broker scripts) before any of
this is real. Explicitly *not* per-piste scoped — every paired device can still
annotate any piste; only "paired vs not paired" is enforced.

**Superseded by a broader discussion, 2026-07-13.** Working through this raised a
bigger question than Atlas's own pairing flow: a security mechanism that only works for
"Atlas talking to Mosquitto" isn't actually a fix for the ecosystem's stated
multi-vendor interoperability goal. That reframing, and the resulting needs/model, now
live in their own document — **`docs/security-provisioning-discussion.md`** — since
it's genuinely a spec-level question (what OPP2 itself should require of any component/
broker), not an Atlas-implementation one. This section's "Option 1" implementation is
a legitimate, useful *Atlas-specific* stopgap in the meantime, not a substitute for
that broader design work, and not assumed to be the final shape once the spec-level
discussion converges.

**Rebuilt to match the converged design, 2026-07-14.** `docs/security-provisioning-discussion.md`
§4.5 settled the Tier B shape (unique-per-device credentials, pre-generated in a batch,
assigned by a pure Atlas-DB action, delivered out-of-band) and explicitly flagged that
Atlas's own "Option 1" stopgap above — shared credential, HTTP-redeemed ticket code —
was not yet updated to match. It now is:

- `scripts/setup-mosquitto-auth.sh` (single shared user) replaced by
  `scripts/top-up-credential-pool.js` (Atlas-DB batch generation, no sudo) +
  `scripts/sync-mosquitto-scoresheet-acl.sh` (pushes the DB's current non-revoked pool
  to Mosquitto, sudo-gated, idempotent full-regeneration each run — same split as
  `generate-tls-cert.sh`/`install-broker-cert.sh` already use for CA vs. broker).
- `services/pairing.js`'s `pairing_tickets`/`paired_devices` tables and
  `createTicket`/`redeemTicket`/`verifyToken` are gone (migration
  `028_scoresheet_credential_pool.sql`), replaced by a single `mqtt_credentials` pool
  table and `createPoolBatch`/`assignCredential`/`listCredentials`/`revealCredential`/
  `revokeCredential`/`poolStats`.
- `routes/pair.js`'s `POST /redeem` is deleted — there is no wire-level exchange for
  Tier B at all anymore, per §4.5. It now only serves `GET /ca-qr` (CA cert bootstrap,
  unrelated to credential delivery).
- `routes/pairing.js` gains `POST /assign` (409 on pool exhaustion), `GET
  /devices/:id/reveal` and `GET /devices/:id/qr` (re-display an already-assigned
  credential without burning a new pool slot — for a device that needs re-pairing after
  e.g. a factory reset), and `GET /pool-stats`.
- The QR/manual-entry payload (§4.6 left this "not yet fully specified") is a URL whose
  **fragment**, not query string, carries `u`/`p`/`l` — `https://openpiste.local:{port}/
  escoresheet/#u=<username>&p=<password>&l=<label>`. Fragments never reach Atlas's own
  server (no access-log leakage) and `escoresheet/js/app.js` immediately
  `history.replaceState`s it away after reading it, so it doesn't linger in the visible
  URL bar or tab history either. Reuses the exact same "QR opens a PWA URL" mechanism
  the old `?pair=code` flow already used — no in-page camera scanner or new client
  library needed.
- `public/pairing.html`'s ticket/countdown UI is replaced by a device-label input +
  "Assign a credential" button, a pool-remaining banner, and a "Show QR again" action
  per active device.
- Revocation is **not instantaneous**, by design (same accepted tradeoff §4.5 already
  signs off on for revocation generally): `POST /devices/:id/revoke` marks Atlas's own
  DB immediately (stops future assignment/reveal), but the credential stays valid at the
  broker until an admin runs `scripts/sync-mosquitto-scoresheet-acl.sh` — called out
  explicitly in `pairing.html`, not left implicit.
- `apparatus`/`software`/`remote`/`var` topics are untouched (still open, no Tier A
  provisioning built) — this pass is scoped to the Tier B/scoresheet credential pool
  only, matching `docs/security-provisioning-discussion.md` §3.3.1's own conclusion that
  every hard problem there currently reduces to this one case.

Verified end-to-end against a throwaway director account and a temporary pool batch on
a second server instance (non-default ports, real dev server left untouched): full
service-layer lifecycle (batch create → assign → pool exhaustion → list omits password →
reveal → revoke → reveal-after-revoke fails) and the equivalent routes over real HTTP,
including the QR image's content-type and the fragment-URL parsing logic
`escoresheet/js/app.js` uses.

**Real bug found and fixed on the first real run, 2026-07-14.** After the user actually
ran `sync-mosquitto-scoresheet-acl.sh` and paired a real device, Atlas's own backend
still saw the apparatus online but the e-scoresheet didn't. Root cause: on Mosquitto
2.0.18, an unscoped/global `topic read #` ACL line only reaches truly anonymous
connections — a client that authenticates with a username (every paired e-scoresheet)
is granted *only* what's written inside its own `user <name>` block, so the paired
device's subscriptions silently received nothing (SUBACK still succeeded, which is what
made this easy to miss). Confirmed against the real broker with the real credential,
then reproduced and fixed against a disposable local Mosquitto instance before touching
the real one. Fix: `scripts/sync-mosquitto-scoresheet-acl.sh` now writes `topic read #`
inside every generated `user` block, not just globally —
`docs/implementation-notes/mosquitto-security.md`'s examples had the identical latent
bug and were corrected the same way, with the finding recorded there for anyone else
following that guide.

**Wired into `install.sh`, 2026-07-14** — a fresh install now provisions a 10-credential
pool (`services/pairing.js`'s `createPoolBatch`, skipped if a pool already exists, same
first-run-only pattern as the admin-account bootstrap) and, if Mosquitto is found on the
same host, automatically runs `sync-mosquitto-scoresheet-acl.sh` to push it live. If the
broker is on separate hardware, install.sh prints the same command as a manual next
step instead of guessing. Previously both steps were purely manual, undiscoverable
follow-ups — the gap that caused the bug above to go unnoticed until a real device was
paired.

---

No protocol changes are proposed here yet — this is entirely about how Atlas (and any
other compliant CMS) would deploy a standalone scoresheet, not a change to `docs/level2.md`.
If anything here eventually implies new OPP2 wire-level conventions (e.g. a standard
pairing-ticket message shape other vendors' scoresheets could also implement), that
still goes through the normal mirror-repo process (CLAUDE.md's "docs/level2.md is a
mirror" rule) before it's real.
