# OPP2 security and provisioning — a discussion document

**Status: draft for discussion. Not part of the spec yet.** Same spirit as
`docs/roles-and-responsibilities-discussion.md` — written to capture and preserve the
reasoning *before* any spec language exists, not to record a decision already made.
Read this alongside that document: that one models who executes a bout function once a
message arrives; this one models how a component earns the right to publish that
message in the first place. Distinct, complementary layers — neither assumes the other.

---

## 1. The problem

OPP2's founding design principle (CLAUDE.md: "ecosystem independence") is that any
component — apparatus, remote control, scoresheet, display, CMS, video review — can be
built by a different, mutually unaware implementer, and everything must still
interoperate correctly as long as each side follows the spec. Today, that principle has
never been extended to *authorization*. In Atlas's own reference deployment, every
Mosquitto listener is `allow_anonymous true` — any device that can reach the broker can
publish to any topic. This isn't an Atlas bug; it's the ecosystem's actual current
state, inherited from EFP1.1/RS422-FPA's much smaller, physically-cabled world where
"on the wire" already implied "authorized."

This surfaced concretely while building Atlas's standalone e-scoresheet PWA
(`docs/e-scoresheet-standalone-design.md`, particularly §4.3's pairing-ticket flow and
§4.8's tracked gap). Pairing produces an application-level bearer token that nothing at
the MQTT layer understands — so a *paired* device, or in fact any device at all, can
publish annotations for any piste. Investigating a fix — Mosquitto ACLs, the
first-party Dynamic Security plugin, a third-party HTTP-auth plugin — revealed that the
real fix isn't Atlas-specific, or even Mosquitto-specific. If OPP2 means what it says
about multi-vendor interoperability, *which broker a venue happens to run* and *how a
component gets authorized to publish* need to be things the spec addresses, the same
way topic structure and message shapes already are. A security mechanism that only
works for "Atlas talking to Mosquitto" isn't a security mechanism for the ecosystem —
it's a workaround for one vendor's deployment.

---

## 2. Needs

Established through direct discussion, in response to a concrete implementation
problem — not derived abstractly first:

1. **Cross-vendor interoperability.** Any compliant component, any vendor, any role,
   must be able to complete a standardized provisioning exchange against any compliant
   broker, with neither side needing to know the other's specific implementation.
2. **Device-capability diversity.** The mechanism must work across genuinely different
   capability classes without assuming the richest one: embedded devices (full control
   of their own TLS stack, can do mTLS natively); browser-based components (cannot
   select/present a client certificate from JS at all, cannot touch a platform
   keystore, persistent storage is plaintext-readable by anything with device access);
   native apps (full flexibility, but the spec can't assume every implementer chose to
   build one).
3. **Deployment-environment constraints already established for this whole ecosystem.**
   No guaranteed internet access. No assumption of a specific broker vendor or product.
   A physically-secured local venue network is the outer perimeter this augments, not
   replaces.
4. **An explicit trust-model statement, not left implicit.** This project has
   repeatedly converged on "not bank-grade — network/physical access plus a
   human-supervised bootstrap ritual is the accepted bar." That belongs in the spec
   itself, so implementers don't over-build (needless crypto complexity) or under-build
   (assuming physical access alone suffices) relative to what's actually intended.
5. **Authorization granularity pinned to the existing publisher-role structure.** The
   topic scheme already partitions by role (`apparatus/*`, `software/*`,
   `scoresheet/*`, `remote/*`, `var/*`). The natural minimum unit of authorization is
   "provisioned for role X," not per-instance or per-piste — those are optional,
   implementation-defined refinements, not spec mandates.
6. **Revocation must be possible, mechanism-defined by the implementation.** A lost,
   stolen, or compromised component is a foreseeable operational reality for any
   vendor's deployment. A compliant broker/CMS combination must be able to revoke a
   previously-provisioned component's access — the spec requires the capability, not a
   specific technique.
7. **Interoperability pinned at the MQTT/TLS protocol level, not a broker's
   proprietary management API.** Username/password at CONNECT and standard TLS client
   certificates are already part of the MQTT/TLS protocols — every broker supports
   them. How a given broker's administrator manages those credentials internally (a
   plugin, a config file, a management API) is not the spec's business; only the
   wire-level result needs to be standard.
8. **The provisioning exchange itself is the one thing that does need standardizing.**
   How a new, previously-unknown component requests and receives a credential — that's
   genuinely OPP2's job, likely expressed as OPP2 messages (or a spec-defined adjacent
   channel, such as a QR payload format), so any vendor's operator tooling can
   provision any vendor's component.
9. **Read/write asymmetry.** Read access can default to open/unauthenticated; the
   requirement is specifically about gating *publish*.
10. **Backward compatibility and optionality.** Real, already-fielded hardware (the
    ESP32 firmware referenced throughout this project) works anonymously today. This
    must be an additive capability layer — a component or broker that doesn't
    implement it should still interoperate at today's baseline, not be locked out.
    Otherwise the ecosystem fractures into incompatible old/new camps.

---

## 3. The model

### 3.1 Two kinds of trust, not one

*Perimeter trust* — physical/network access to the venue — is already assumed by the
whole ecosystem; nothing new is needed there. *Component trust* — "this specific
device is legitimately part of this deployment, entitled to publish as role X" — is
what provisioning actually establishes. Keeping these separate matters: the spec only
needs to solve the second one, not re-litigate physical venue security.

### 3.2 Provisioning always traces back to a human

Every provisioning path ends with an operator taking an action that vouches for the new
component. This is not a weakness to engineer around — it's consistent with how a
physical apparatus already gets deployed at a venue (someone plugs it in and turns it
on). There is no attempt here to solve "how do two mutually-suspicious parties
establish trust with zero human involvement," because that was never the actual
problem this ecosystem has.

### 3.3 Two provisioning tiers, by device capability — both legitimate, neither a
workaround for the other

- **Tier A — capable devices** (embedded firmware, native apps): a fully scripted
  exchange, no manual OS-level step beyond initial physical setup. This is what the
  real ESP32 firmware's existing certificate-based enrolment already does today (see
  `reference_scoring_device_firmware` / `~/mqtt-web/enrolment.js`'s CA + CSR flow, the
  direct precedent for this whole line of thinking).
- **Tier B — constrained devices** (browsers/PWAs): the spec explicitly *accepts* that
  provisioning requires at least one manual, OS-level trust action — installing a CA
  root, entering an operator-relayed code — as a named, legitimate tier, not something
  to keep trying to engineer away. The friction here is an inherent property of the
  browser platform (no JS API to select a client certificate, no access to a platform
  keystore), not a defect in any particular implementation of it — confirmed directly
  against Atlas's own PWA build-out in `docs/e-scoresheet-standalone-design.md`.

Both tiers converge on the same outcome — the broker enforces role-scoped publish
authorization via a standard MQTT/TLS mechanism (client certificates fit Tier A
naturally; username/password fits Tier B) — they simply arrive there by paths
appropriate to what that device class can actually do. A future component that *can*
do more than its tier's baseline is always free to use the stronger mechanism; the
spec's job is to guarantee a working floor for the weakest realistic device class, not
to cap what a capable one may do.

### 3.3.1 Everything hard about this discussion turns out to be Tier-B-only

This wasn't obvious until working through the actual message exchange (Section 4) —
recorded here because it changes where effort needs to go.

**Tier A gets per-device identity, real revocation, and freedom from any broadcast-
confidentiality concern for free, from standard, already-universal, *static* broker TLS
features — no dynamic broker capability of any kind is needed:**
- A certificate is signed using the CMS's own already-held CA key (`data/tls/ca.key`)
  — a purely local, in-process signing operation. As long as the broker has
  `require_certificate true` and trusts that CA, any certificate the CMS signs is
  automatically valid at the TLS handshake. The broker is never told anything new at
  request time; there is no dynamic provisioning step on the broker side at all.
- A certificate isn't secret — that's the point of a certificate. The private key never
  leaves the device (standard CSR flow, same as the existing ESP32 firmware precedent:
  the device generates its own keypair locally, only the CSR — public information —
  goes out, only the signed cert — also public — comes back). So a Tier A response
  broadcast to every subscriber leaks nothing usable.
- Revocation has ordinary, well-understood PKI answers — nothing OPP2-specific to
  invent. Decided concretely in Section 4.4: a CRL, not OCSP, mirroring the same
  static-file-over-live-service reasoning applied to Tier B.

**Username/password (Tier B) has none of these free byproducts.** A broker can't
validate it against a locally-held root of trust the way it validates a certificate —
it has to actually *learn about* each credential somehow. That's the origin of every
hard question this document has wrestled with: dynamic broker-side credential
provisioning (Section 4.5's premise), and the broadcast-confidentiality problem that
follows from delivering a genuine secret over MQTT pub/sub.

**The scope this implies is narrower than "PWA."** The constraint tracks the
*implementation platform* (can this software present a TLS client certificate at all),
not which of the five publisher roles a component fills. A native app or embedded
device providing *any* role is Tier A and never hits this wall; a hypothetical
browser-based remote control or browser-based video-review tool would hit exactly the
same wall a browser-based scoresheet does — the category is "browser-implemented
publisher," not "scoresheet" specifically. **In practice, today, in this ecosystem, the
standalone e-scoresheet is the only component that is both (a) implemented as a PWA and
(b) needs publish capability at all** — apparatus and remote are physical/embedded by
their nature, video review doesn't exist as a built component yet, and the CMS is the
provisioning *authority* in this model, not something that gets provisioned. So the
practical takeaway is sharper than the general one: **every hard problem in this
document currently reduces to a single, narrow case — the e-scoresheet, and anything
like it that might exist in the future.** A deployment with only embedded/native
components never needs any of Section 4.5's machinery at all.

### 3.4 The credential's shape is standard; the provisioning exchange is what OPP2
defines

This is the load-bearing architectural split. The spec never mandates *how* a broker
manages credentials internally — only (a) the wire-level shape of the credential
itself (MQTT username/password, and/or a TLS client certificate — both already
standard, broker-agnostic concepts) and (b) the request/grant message exchange for
obtaining one. Which broker software a venue runs, and how that broker's administrator
wires up dynamic user management, is exactly as out-of-scope for OPP2 as which
database a CMS uses internally.

### 3.5 Authorization stays role-scoped; revocation is a required capability, not a
required mechanism

Matches needs 5 and 6 directly. Per-instance or per-piste scoping remains available to
any implementation that wants it, but isn't the compliance floor.

### 3.6 This whole layer is additive and negotiable, not a breaking requirement

Needs some way for a component or broker to signal "I support this" — plausibly
extending `apparatus/connection`/`software/connection`'s existing payload (Sections 8–9
of `docs/level2.md`) rather than inventing a new message type. Not yet designed — see
Section 4.

---

## 4. The provisioning exchange — a sketch (2026-07-14)

### 4.1 Two halves with very different scope

**Half 1 — an operator generates a ticket.** This is CMS-internal (an authenticated
admin action, a UI, a database row) and **explicitly out of OPP2's scope** — no more
standardized than "how you log into a CMS's admin panel" ever was. Every CMS already
needs its own operator authentication for other reasons; there's nothing to unify here.

**Half 2 — the new component redeems it.** This is the part that's actually OPP2's job,
since a Vendor B scoresheet needs to be able to redeem a ticket a Vendor A CMS issued.
For Tier A this is a genuine wire-level MQTT exchange (Section 4.2–4.4). For Tier B,
per the decision in Section 4.5, it turns out not to be a network exchange at all — the
credential itself is conveyed out-of-band, and the only thing needing a standardized
shape is a QR payload format (Section 4.6).

### 4.2 Tier A: MQTT-based exchange

The reasoning for MQTT over HTTP holds fully for Tier A (embedded/native — the devices
that will actually use this):

- A vendor's CMS HTTP API shape (routes, auth, JSON conventions) isn't standardized and
  doesn't need to be — but if redemption *required* HTTP, every component would have to
  discover and speak to some vendor-specific HTTP endpoint, on top of MQTT.
- **Cross-origin access is a concrete problem for HTTP specifically**, for any
  component genuinely independent of the CMS issuing its ticket — a third-party
  component calling a different vendor's CMS HTTP API is a cross-origin request,
  requiring that CMS to have CORS configured permissively. MQTT has no equivalent
  restriction.
- A Tier A device already needs an MQTT connection to do anything else in this
  ecosystem; requiring it to *also* implement an HTTP client purely for provisioning is
  one more thing to get right, for no benefit once request/response works over the
  broker itself. (Real precedent already does this successfully — the ESP32 firmware's
  existing CSR-based enrolment — so this isn't a hypothetical burden either way, just a
  reason not to add a second protocol stack where MQTT already suffices.)
- Tier A responses carry certificates — not secret, safe to broadcast to any
  subscriber (§3.3.1) — so MQTT pub/sub's broadcast nature is a non-issue here.

Topic shape and message shapes below apply to **Tier A only**.

### 4.3 Topic shape (naming is a first draft, not final)

```
openpiste/_provision/request
openpiste/_provision/response/{device_id}
```

`_provision` is a reserved pseudo-`piste_id`, documented as never usable as a real one.
`{device_id}` is a client-generated opaque correlation id — the requester subscribes to
its own response topic before publishing the request, an ordinary MQTT request/response
pattern that needs no MQTT5-specific features. Both topics QoS 1, **not retained** —
one-shot events, matching the existing convention already established for `control`
(§4.5 of `docs/level2.md`).

Broker address discovery needs no new mechanism: §4.2 of `docs/level2.md` already
establishes `openpiste.local` via mDNS as the default any component should try first,
with fallback to a configured host — the ticket/QR payload (Section 4.6 below) doesn't
need to duplicate this.

### 4.4 Message shapes (Tier A)

**Request** (published by the new component):

```json
{
  "protocol": "OPP2", "version": "1.0", "seq": 1, "ts": 1715539200000,
  "code": "482913",
  "role": "apparatus",
  "device_id": "b6a1c2d3-...",
  "device_label": "OpenPiste-ESP32",
  "csr": "-----BEGIN CERTIFICATE REQUEST-----..."
}
```

| Field | M/O | Description |
|-------|-----|-------------|
| `code` | M | The human-relayed ticket code from Half 1 |
| `role` | M | Publisher role being requested — `apparatus`\|`scoresheet`\|`remote`\|`var`. Note this is *not* the same axis as tier: a native (non-browser) scoresheet app is legitimately Tier A and requests `role: scoresheet` here same as any other Tier A device — tier is about device capability, role is about function, and they're orthogonal. `software` is never requested — the CMS is the provisioning *authority* in this model (§3.1), never something provisioned by itself. |
| `device_id` | M | Client-generated opaque id; also the response topic's correlation segment |
| `device_label` | O | Human-readable description |
| `csr` | M | PEM-encoded certificate signing request |

**Response** (published by the CMS):

```json
{ "protocol": "OPP2", "version": "1.0", "seq": 2, "ts": 1715539201000,
  "status": "granted", "role": "apparatus",
  "cert": "-----BEGIN CERTIFICATE-----...", "ca_cert": "-----BEGIN CERTIFICATE-----..." }
```

Failure: `{"status": "denied", "reason": "invalid_or_expired_code"}`. No confidentiality
concern here — broadcasting a signed certificate to any subscriber leaks nothing
(§3.3.1) — so the "who can read this" question that motivated the rest of this section
in an earlier draft simply doesn't apply to Tier A.

**Revocation, decided — mirrors Tier B's shape rather than inventing something new.**
§3.3.1 waved at "CRLs, OCSP" without picking one; that's not good enough given Tier B
got a concrete answer. Following the same reasoning that resolved Tier B (prefer a
static, occasionally-reloaded file over a live service):

- **A CRL (Certificate Revocation List), not OCSP.** Mosquitto (and TLS broker
  implementations generally) support checking a client certificate against a `crlfile`
  at the TLS handshake — a standard, static, OpenSSL-backed mechanism, not a plugin.
  OCSP would need a *live* responder service queried on every connection — explicitly
  ruled out as unnecessary infrastructure for the same reason Dynamic Security and an
  HTTP-auth webhook were ruled out for Tier B: a static file, reloaded occasionally, is
  sufficient, and revocation is rare and exceptional, not latency-sensitive the way
  pairing is.
- **Same operational shape as Tier B's revocation:** an operator revoking a Tier A
  device means adding its certificate's serial number to the CRL file and triggering a
  reload — a few seconds' delay, acceptable for the same reason it was acceptable for
  Tier B (revocation isn't something an operator is standing there waiting on).
- **A bounded certificate lifetime as a second, complementary layer** — recommended,
  not in place of the CRL: issuing Tier A certificates with a validity period scaled to
  realistic deployment lifetimes (e.g. on the order of a season, not decades) means a
  device that's lost or decommissioned and never explicitly revoked still stops working
  within a bounded window, the same "regenerate periodically" spirit already applied to
  the CA itself (`scripts/generate-tls-cert.sh`'s default behaviour) and to Tier B's
  credential pool.

### 4.5 Tier B: decided — username:password, unique per device, delivered out-of-band

**This is settled, not a leaning.** For Tier B (browsers/PWAs — no certificate option
exists at all, §3.3.1):

- **The credential is always a username/password pair, never a certificate.** A
  certificate can't be *used* by a browser even if the CMS creates one — there is no
  scriptable way for a web page to make a browser present a client certificate at
  connection time. It requires a native OS "install this identity" flow, same category
  of action as the CA-root install Tier B already requires — and it would be a *second*
  such action, needing a password-protected key bundle (a new secret to convey) and
  risking a certificate-picker prompt on every future connection, not just once. Restated
  from first principles, this is the same wall reached when client certificates for Tier
  B were first considered — creating the certificate was never the hard part.
- **The credential is unique per device, never shared.** This was the point of
  reopening this whole question: a shared Tier B credential means one compromised
  device breaks the guarantee for every device sharing it. A unique credential confines
  a compromise to the one device that leaked it, and gives a real, individual thing to
  revoke. It also means **a breach is straightforward to attribute** — if a specific
  device's credential is used somewhere it shouldn't be, that identifies which physical
  device to investigate, not "one of however many devices share this."
- **Unique-per-device does *not* imply the broker needs live/dynamic credential
  creation** — this was assumed earlier in this discussion and turns out to be wrong.
  The operator knows, before a competition starts, roughly how many Tier B devices will
  need pairing. A batch of N credentials (e.g. `escoresheet_1:<random>` …
  `escoresheet_N:<random>`) can be pre-generated once, ahead of time — the same kind of
  one-time, sudo-gated setup script already established for this project
  (`scripts/setup-mosquitto-auth.sh`), just producing N distinct entries instead of one
  shared one. **What has to feel instant is *assignment*, not *creation*** — pairing a
  device at runtime means the CMS's own operator-facing UI (Half 1) picking the next
  unused entry from a pool it already holds (tracked in its own database, a natural
  extension of `paired_devices`) and rendering it directly as the QR described below —
  no separate network step, and no broker interaction, happens at pairing time at all.
  Revocation still touches the broker (disabling one
  entry means editing the password file and reloading), but revocation is rare and
  exceptional, not the frequent hot-path operation pairing is — a few seconds' delay
  for a `SIGHUP`-triggered reload after an operator deliberately revokes a lost device
  is a perfectly acceptable bar, unlike pairing, which an operator is standing there
  waiting on. **This removes the Dynamic Security / HTTP-auth-webhook question
  entirely** — a plain, static password file, regenerated/reloaded occasionally, is
  sufficient. The only operational wrinkle is running out of pre-generated headroom,
  which just means re-running the same batch script to top up the pool — itself
  occasional, not urgent, same as revocation.
- **Delivery is out-of-band — a QR code (or manual entry) encoding the assigned
  credential directly — not a network exchange at all.** This superseded an earlier
  version of this decision that used HTTP specifically to get point-to-point delivery;
  a QR/manual channel has that same property for a simpler reason: it never touches the
  network as a secret in the first place, visible only to whoever is physically looking
  at the operator's screen. This is not a new mechanism bolted on for confidentiality —
  it's the same human-supervised, out-of-band channel the whole model already rests on
  (§3.2) doing double duty, carrying the credential itself rather than just a code that
  unlocks one. It also **fully removes the "genuinely independent third-party Tier B
  component" caveat** the HTTP version still had — no cross-origin call is involved at
  all, so this works identically regardless of which vendor built the component or
  where it's hosted, a better fit for Need 1 than the HTTP version was. No wire-level
  provisioning exchange exists for Tier B at all; the only thing that needs a
  standardized shape is the QR payload format itself (Section 4.6).
- **Real, accepted tradeoff: this credential is long-lived, unlike a short-lived ticket
  code.** A photo of the QR (or someone glancing at the screen) captures a working
  credential for as long as it remains valid, not a code that expires in minutes. This
  was weighed deliberately, not overlooked: the exposure window is bounded by the
  operator's own conduct (dismissing the QR from their screen promptly once shown,
  matching the same director-assisted, human-supervised model everything else in this
  design already leans on), and revocation is already cheap in the pool model (the
  bullet above) if a specific credential is ever suspected of being seen by the wrong
  person. Accepted as low risk given that combination, not because the exposure is zero.
- **The at-rest storage floor is accepted, not solved.** Whatever a browser can persist
  (`localStorage` or equivalent) is plaintext, readable by anything with access to that
  specific device — no browser API changes this, and delivery mechanism doesn't touch
  it (§ "at rest" is a separate exposure window from § "in transit," discussed and
  accepted in this same conversation). Per-device credentials bound the *consequence* of
  this floor (one device's compromise, not every device's); they don't remove the floor
  itself.
- **Two operational recommendations, not protocol requirements:** devices holding a
  Tier B credential should be recommended to use their platform's own lock screen (PIN/
  password/biometric) when not in active use, bounding the at-rest exposure window; and
  the operator should be recommended to dismiss the credential-bearing QR from their own
  screen promptly once shown, bounding the delivery exposure window (the tradeoff
  bullet above). Neither changes any wire-level guarantee — both raise the bar against
  casual/opportunistic access, which is the actual realistic threat model here.

### 4.6 Ticket/QR payload

For **Tier A**, since broker address discovery is already handled by the existing mDNS
default (`docs/level2.md` §4.2), the ticket/QR payload only strictly needs to carry the
code itself, plus an optional explicit broker override for the case §4.2 already
anticipates ("fallback to a configurable IP address or hostname"). Not yet fully
specified — a URI-like scheme (e.g. `openpiste-provision://482913?broker=openpiste.local:9002`)
is the working direction, not a commitment.

For **Tier B**, per the current 4.5, the QR carries the *assigned credential itself*
(username/password), not a redeemable code — the device is already on the CMS's own
page (already knows the broker via the same mDNS default), so nothing else needs
conveying. Not yet fully specified — a small JSON or URI-style payload (e.g.
`openpiste-credential://escoresheet_7:xyz...`) is the working direction. **This
supersedes Atlas's own currently-shipped implementation**, which still uses a
short-lived numeric ticket code redeemed via HTTP (`docs/e-scoresheet-standalone-design.md`
§4.3, `routes/pair.js`) — that code is real and working, but reflects an earlier point
in this same discussion, not the converged design. Updating it to match is a real,
separate implementation task, not done as part of this document.

### 4.7 Capability signaling

Proposal: extend `apparatus/connection`/`software/connection`'s existing payload
(`docs/level2.md` §8–9) with an optional field, e.g. `"provisioning_tiers": ["A","B"]`.
Absent means "doesn't support this layer" — stays backward compatible per need 10.

### 4.8 A related, adjacent spec gap noticed while researching this (not part of
provisioning itself)

`docs/level2.md` §4.7 ("Port") only documents `1883`/`8883` — it doesn't mention
WebSocket ports at all, even though a browser-based component (Tier B, or any browser
display) structurally cannot reach the broker any other way. This blocks Tier B
regardless of how provisioning itself is resolved, and is worth fixing independently.

---

## 5. Still not designed

- ~~Section 4.5's broadcast-confidentiality open question — which of the three options
  to take, if any.~~ **Resolved 2026-07-14** (§4.5): moot either way. Tier B's
  delivery ended up out-of-band (QR/manual), which never touches the network as a
  secret at all; Tier A was never exposed to it either (certificates aren't secret).
  Nothing left to decide here.
- ~~The broker-side requirement this decision implies — does a compliant broker need
  live/dynamic credential creation?~~ **Resolved 2026-07-14** (§4.5): no. Unique-per-
  device does not imply dynamic broker capability — provisioning is a pre-generated
  batch (sized to the operator's known device count), assigned, not created, at
  pairing time. A plain static password file, reloaded occasionally, is sufficient;
  the Dynamic Security / HTTP-auth-webhook question this earlier appeared to force
  doesn't need answering after all.
- ~~Whether Tier A's credential issuance is itself standardized, including revocation.~~
  **Resolved 2026-07-14** (§4.4): the request/response shape is the standardized part;
  how a CMS internally signs a CSR is implementation-defined, same principle as
  everywhere else in this document. Revocation is a CRL, not OCSP — mirrors Tier B's
  static-file-over-live-service reasoning.
- Whether per-piste/per-instance scoping ever graduates from optional to a MUST, and
  under what conditions.
- The relationship between this document's "component trust" and
  `docs/roles-and-responsibilities-discussion.md`'s executor model needs to stay
  clean: that document assumes a message arrived from an already-authorized publisher
  and asks who acts on it; this document is entirely about how a publisher becomes
  authorized to begin with. Keep these two concerns from bleeding into each other as
  both documents evolve.

---

## 6. What this document is not

No protocol changes are proposed here. No spec section is being edited yet. This exists
to be read, argued with, and revised before a single line of `docs/level2.md` changes —
so that whatever eventually gets written reads as a reasoned consequence of the needs
in Section 2 and the model in Section 3, not an arbitrary implementer's opinion, and so
that the reasoning behind it survives even if the eventual spec language ends up much
terser than the discussion that produced it.
