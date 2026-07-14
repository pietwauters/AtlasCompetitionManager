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
This is what needs a wire format, and is the subject of the rest of this section.

### 4.2 Why MQTT messages, not HTTP — reversing what Atlas's own implementation does

Atlas's own pairing flow (`docs/e-scoresheet-standalone-design.md` §4.3,
`routes/pair.js`) is HTTP. That's a reasonable *implementation* choice for Atlas talking
to Atlas's own PWA, but not the right shape for the *spec's* device-facing half:

- A vendor's CMS HTTP API shape (routes, auth, JSON conventions) isn't standardized and
  doesn't need to be — but if redemption *requires* HTTP, every component now has to
  discover and speak to some vendor-specific HTTP endpoint, on top of MQTT.
- **Cross-origin browser access is a concrete, not just theoretical, problem for HTTP
  specifically.** A Vendor B scoresheet PWA hosted on its own origin, calling Vendor A's
  CMS HTTP API directly from browser JS, is a cross-origin `fetch()` — it requires
  Vendor A's CMS to have CORS configured permissively for arbitrary origins.
  MQTT-over-WebSocket has no equivalent restriction. This is a real technical point in
  favor of MQTT, not a stylistic preference.
- Every component already needs an MQTT connection to do anything else in this
  ecosystem; requiring it to *also* implement an HTTP client purely for provisioning is
  one more thing to get right, for no benefit once request/response works over the
  broker itself.

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

### 4.4 Message shapes

**Request** (published by the new component):

```json
{
  "protocol": "OPP2", "version": "1.0", "seq": 1, "ts": 1715539200000,
  "code": "482913",
  "role": "scoresheet",
  "device_id": "b6a1c2d3-...",
  "device_label": "Chrome on Android",
  "tier": "B",
  "csr": null
}
```

| Field | M/O | Description |
|-------|-----|-------------|
| `code` | M | The human-relayed ticket code from Half 1 |
| `role` | M | Publisher role being requested — `apparatus`\|`software`\|`scoresheet`\|`remote`\|`var` |
| `device_id` | M | Client-generated opaque id; also the response topic's correlation segment |
| `device_label` | O | Human-readable description |
| `tier` | O | `"A"` (can present a CSR) or `"B"` (needs username/password) — lets the CMS decide what it's willing to grant |
| `csr` | O | PEM-encoded certificate signing request — present only for a Tier A cert request |

**Response** (published by the CMS):

```json
{ "protocol": "OPP2", "version": "1.0", "seq": 2, "ts": 1715539201000,
  "status": "granted", "role": "scoresheet",
  "username": "scoresheet_b6a1...", "password": "..." }
```

Tier A success carries `{"cert": "...", "ca_cert": "..."}` instead of
`username`/`password`. Failure: `{"status": "denied", "reason": "invalid_or_expired_code"}`.

### 4.5 Open question, deliberately not resolved here

MQTT pub/sub is fundamentally more "broadcast" than HTTP's point-to-point — a
`PUBLISH` to `_provision/response/{device_id}` is technically visible to *any*
wildcard subscriber, not just the intended recipient, unlike an HTTP response. That
matters specifically here because the payload can carry a live credential. Three ways
to handle it, presented without picking one:

1. **Accept it** — consistent with the "not bank-grade, local network access is
   semi-trusted" bar already established throughout this project.
2. **Make this one topic namespace a documented exception to "read stays open"
   (need 9)** — cheap, closes the actual gap, but is an asymmetric carve-out in an
   otherwise-clean rule.
3. **Encrypt the sensitive response fields using a key derived from the ticket code
   itself** (already a shared secret only the legitimate requester and issuing CMS
   know) — closes it properly, but adds real crypto-correctness burden on every
   implementer, including browser JS.

Leaning toward (2) — cheapest fix that actually closes the real gap — but this is
exactly the kind of tradeoff that deserves a deliberate decision, not a default.

### 4.6 Ticket/QR payload

Since broker discovery is already handled by the existing mDNS default (§4.2), the
ticket/QR payload only strictly needs to carry the code itself, plus an optional
explicit broker override for the case §4.2 already anticipates ("fallback to a
configurable IP address or hostname"). Not yet fully specified — a URI-like scheme
(e.g. `openpiste-provision://482913?broker=openpiste.local:9002`) is the working
direction, not a commitment.

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

- Whether Tier A's credential issuance (the CSR-based flow) is itself standardized —
  format, transport — beyond the request/response shape in Section 4.4, or left
  fully implementation-defined for how the CMS actually signs and issues it.
- Whether per-piste/per-instance scoping ever graduates from optional to a MUST, and
  under what conditions.
- Section 4.5's open question — which of the three options to take, if any.
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
