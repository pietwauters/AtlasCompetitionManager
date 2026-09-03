# Distribution & licensing — discussion (started 2026-09-03)

Non-normative brainstorm, nothing implemented. Started mid-session while test-driving
today's Pi-image provisioning flow (`docs/pi-image-quickstart.md`), on the question:
"once this works, how would I actually hand a Pi to a client, and how would I license
it?" Two separate but related threads — read the file directly, same pattern as
`docs/cross-platform-deployment-discussion.md` and the other `*-discussion.md` docs.

## 1. Golden-image appliance distribution

**Problem with today's flow for real client distribution**: `atlas-firstboot.sh`
clones the repo from GitHub and runs a full `apt`/`npm ci` install on every single
deployment. That's the right shape for *development* (every boot gets the latest
code, no rebuild step) but the wrong shape for shipping to a client — it re-downloads
the same hundreds of MB every time, and depends on the client having decent internet
on-site the day they set it up, which the rest of Atlas's design deliberately doesn't
assume (local broker, local NTP — see `docs/level2.md` §4.3 and the deployment-
robustness scripts).

**Design: split "build once" from "personalize per unit."** Same pattern cloud image
builders use:

- **Golden image** (slow to build, built once): every *package* baked in — apt deps,
  Node via NodeSource, the app's `node_modules` already `npm ci`'d, PM2 installed,
  Mosquitto/chrony installed — but **no per-unit identity**.
- **First-boot personalization** (fast, runs fresh on every individual unit):
  regenerate identity, nothing else.

**Critical constraint — never bake per-unit identity into the golden image.** This
isn't a nice-to-have, it's the same trust model the Tier A mTLS work and this
session's own [[project_forced_pin_change_gate]] fix depend on:

- **`data/tls/ca.key`** — the entire OPP2 trust root for a venue. Identical across
  every client's Pi means any one client's Pi (or anyone who extracts that key from
  one) could mint certificates every *other* client's Pi would also trust. Full
  cross-tenant compromise, not a cosmetic issue.
- **SSH host keys** — cloned identical across a fleet is a textbook MITM setup.
- **`/etc/machine-id`** — duplicated across a fleet causes real (if subtle)
  DHCP/systemd/journald bugs.
- **`data/atlas.db`** — captured after any real use means every client starts with
  your test data, and possibly an admin PIN that's already had `force_pin_change`
  cleared during your own testing — silently undoing the server-side PIN gate built
  earlier this session.

The personalization step is basically the *back half* of today's
`atlas-firstboot.sh` already — the cert chain (`generate-tls-cert.sh` →
`install-broker-cert.sh` → `provision-cms-client-cert.sh` → ACL sync → CRL push) and
`install.sh`'s admin-bootstrap logic are already idempotent/scriptable and assume a
clean slate. What's **not** handled by anything today: explicit SSH host key and
`machine-id` regeneration on first boot of a cloned unit. Raspberry Pi OS's stock
imaging path may already regenerate host keys on a genuinely fresh flash (worth
confirming, not assumed) — but a `dd`-cloned golden image is a different case: by the
time you capture the golden image, that mechanism (if it exists) has already run once
and marked itself done, so clones from that point on would **not** get fresh keys
unless the golden-image build explicitly resets it before capture.

**Producing the compressed image**: capture the finished golden SD/USB with `dd`,
shrink with **PiShrink** (third-party, not preinstalled — trims the ext4 partition +
image file to just what's used, often 32GB→3-4GB before gzip), then gzip. Clients can
keep using the *same* `rpi-imager` tool — its "Choose OS → Use custom" flashes an
arbitrary local `.img`/`.img.gz` exactly like the official catalog entries, so the
client-facing workflow barely changes from what `docs/pi-image-quickstart.md`
documents today.

**Not yet built.** This is a "shipping v1 to real clients" milestone, distinct from
the "get it running myself, find the limits" goal that's driving today's session (see
[[project_cross_platform_cms]]).

## 2. Licensing model

**Key constraint to resolve first**: this repo is currently **public** on GitHub
(`https://github.com/pietwauters/AtlasCompetitionManager` — `atlas-firstboot.sh`
itself clones it over plain HTTPS, no auth). Full source is already visible to
anyone today. This materially limits which commercial models are viable without a
deliberate decision to change repo visibility going forward.

**Options considered:**

- **(a) Open source + monetize hardware/service.** Keep the software open, make
  money on ready-to-go Pi appliance kits (the golden-image work above), support
  contracts, or customization for federations. Natural fit given the appliance work
  already underway; well-trodden path for open-source hardware appliances generally.
- **(b) Open-core.** Free base, paid "pro" tier (the eventual OPP2 cloud bridge,
  multi-tournament management, premium reporting, priority support) gated behind a
  license check. Adds real complexity: needs a license-key mechanism that still
  works fully offline — competition day has no guaranteed internet, the same
  constraint that already shaped the local broker/NTP design.
- **(c) Fully closed-source + license keys.** Requires making the repo private (or
  relicensing) going forward. In real tension with the "must work fully offline,
  mid-competition" design philosophy — a phone-home check is a poor fit; would need
  an offline-verifiable signed license file with graceful, non-blocking degradation
  (a warning, not a hard lock) rather than bricking the app mid-tournament, which
  would be a genuinely serious failure mode for a live competition tool.
- **(d) Dual licensing** (e.g. AGPL for self-hosters/small clubs + a separate
  commercial license for orgs wanting to embed/white-label or avoid copyleft
  obligations) — MySQL's model. More administrative overhead than a solo/small
  project may want to carry.
- **(e) A paid layer on top of the still-free/local app.** CLAUDE.md's own roadmap
  already treats the OPP2 cloud bridge as lower-priority precisely because "local
  operation is fully functional without it" — that's already a deliberate design
  principle, not something to retrofit. A paid hosted/cross-venue layer sits on top
  of that boundary naturally rather than fighting it.

**Client-base reality worth weighing in**: fencing clubs and national federations
are typically nonprofit, volunteer-run, and budget-constrained. A traditional
enterprise per-seat/audit licensing model is likely a poor cultural and practical
fit regardless of which technical option is chosen.

**A rough recommendation, not a decision** — (a), open software + paid
hardware/service, fits both the likely client base and the appliance-distribution
work already underway; (e) layers on cleanly later if a genuine cloud/hosted feature
becomes real, without requiring (b)/(c)'s license-enforcement machinery at all.

**Open questions for the user to actually decide, next time this resumes:**
- Keep the repo public, or go private going forward?
- If staying open: permissive license, or copyleft/AGPL specifically (AGPL's real
  effect here is stopping someone from taking Atlas, hosting it as a competing SaaS,
  and not sharing their changes back — it doesn't restrict a club's ordinary "run it
  on our own Pi" use at all)?
- Is a paid *software* tier wanted at all, or should monetization stay entirely on
  hardware/service and leave the software itself unrestricted?

## Origin

2026-09-03, arose mid-session during a real Pi hardware test-drive
([[project_cross_platform_cms]]), immediately after the golden-image distribution
idea came up. Related: [[project_forced_pin_change_gate]] (the identity-must-not-be-
shared constraint this doc leans on), [[project_deployment_robustness]] (the
provisioning scripts the personalization step would reuse).
