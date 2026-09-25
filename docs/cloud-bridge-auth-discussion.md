# Cloud bridge authentication — a discussion document

**Status: draft for discussion, started 2026-09-25. Nothing implemented beyond the
shared-credential baseline described in §1.** Same spirit as
`docs/security-provisioning-discussion.md`: written to preserve the reasoning before
any spec language or code exists. That document covers how a component earns the right
to publish on a *venue's* broker. This one covers the next hop: how a venue earns the
right to publish on the *cloud* broker (`docs/level2.md` §31).

---

## 1. Where things stand

`scripts/configure-cloud-bridge.sh` (built 2026-09-25, first real run against
`mqtt.openpiste.org` the same day) configures a static, native Mosquitto bridge from
the venue broker to the cloud broker, under the tournament-level prefix merged upstream
in OpenPiste/protocols#23:

```
openpiste/{NOC}/{yyyy}/{mm}/{dd}/{tournament_id}/{piste}/{publisher}/{type}
```

The bridge authenticates with **one shared username and password** (`bridge`), and the
cloud broker's ACL grants that user `readwrite openpiste/#`. The password sits in plain
text in `/etc/mosquitto/conf.d/openpiste-cloud-bridge.conf` (0640 root:mosquitto) on
every venue machine that has ever been configured. Traffic is TLS-encrypted, so
eavesdropping on the link isn't the concern. Authorization is.

This was deliberately the smallest thing that could work for a first test. It won't
hold up once more than a handful of venues are connected.

## 2. What's wrong with a shared credential

1. **No scoping.** Any venue holding the password can publish under *any*
   tournament's path: fake another venue's scores, overwrite its retained
   `software/record`, replace or clear its identity message. The collision check in
   the script only protects against honest mistakes. It is a courtesy, not a control.
2. **One leak compromises every venue, and revoking it disconnects every venue.** Pis
   get lost, lent out, re-imaged, and resold (see
   `docs/distribution-and-licensing-discussion.md` on golden images and never baking
   per-unit identity into a shared image). Rotating the password after a leak means
   reconfiguring every venue at the same moment, including ones mid-tournament.
3. **No attribution.** The cloud broker sees a single user, so misuse can't be traced
   to a venue, and nothing can be rate-limited or revoked per venue.
4. **No expiry.** A credential issued for one tournament stays valid for every
   tournament after it.

## 3. Threat model

In rough order of likelihood:

| Actor | What they can do today | What we want |
|---|---|---|
| Honest operator, wrong `tournament_id` | Overwrites another tournament's data | Refused by the broker, not just warned by the script |
| Lost / stolen / resold venue Pi | Publishes anywhere, indefinitely | Can publish only under its own tournament, and only until that tournament ends |
| Curious or malicious organiser | Tampers with a rival event's live results | Confined to their own tournament's path |
| Misbehaving or buggy venue (message flood) | Degrades the broker for everyone | Identifiable and individually cut off |
| Network eavesdropper | Nothing (TLS) | Unchanged |

Out of scope: a venue lying about *its own* tournament's results. Authentication
proves which venue published, not whether the scores are true. That's the job of the
referee/scoresheet authority chain (`docs/roles-and-responsibilities-discussion.md`).

## 4. Needs

- **N1 — Scope.** A credential can write only under one tournament's subtree.
- **N2 — Expiry.** A credential stops working after its tournament ends, without
  anyone having to remember to revoke it.
- **N3 — Individual revocation.** One credential can be killed without touching any
  other venue.
- **N4 — Attribution.** The broker knows which credential published what.
- **N5 — Still a native bridge.** No custom relay software at the venue. This was
  §31.1's reason for choosing MQTT and the reason for the #23 rework, so it shouldn't
  be traded away here.
- **N6 — Workable for a non-technical organiser.** Getting a credential must not
  require understanding PKI. It's fine for it to require an internet connection and a
  one-time step before the event.
- **N7 — Nothing secret in a shared image.** A credential is created per unit and per
  tournament, never baked into a distributable image.

## 5. Options

### 5.1 A — Per-tournament username/password, scoped by ACL pattern

Issue a credential per tournament with username = `tournament_id`. On the cloud
broker:

```
pattern readwrite openpiste/+/+/+/+/%u/#
```

Mosquitto substitutes `%u` with the authenticated username, so each login can only
touch its own tournament's subtree. The dynamic-security plugin lets users be added and
removed at runtime without a broker restart.

- Meets N1, N3, N4, N5. Small change to the script (it already takes a username).
- **Fails N2**: a password doesn't expire by itself. Expiry means a cloud-side job
  deleting users after `end_date`, and a forgotten job means credentials live forever.
- The secret is still a password, stored in plain text on the venue machine and
  delivered to the organiser through some channel (email?) that is itself a leak risk.

### 5.2 B — Per-tournament client certificate (mTLS) — recommended

The venue machine generates its own private key and a certificate signing request
(CSR). A cloud-side CA signs it. The certificate's identity is the tournament, and its
validity window covers the tournament dates. The cloud listener sets
`use_identity_as_username true` (or `use_subject_as_username`), so the same `%u` ACL
pattern as option A scopes it.

On the venue side it's still a native Mosquitto bridge:

```
bridge_cafile   /etc/openpiste/cloud-ca.crt
bridge_certfile /etc/openpiste/bridge.crt
bridge_keyfile  /etc/openpiste/bridge.key
```

- Meets every need. **N2 comes free**: the certificate's `notAfter` enforces expiry
  even if nobody remembers to revoke it. **N7 comes free**: the key is generated on
  the unit and never leaves it, so there's no secret to deliver and nothing to email.
- N3 via a CRL on the cloud listener (`crlfile`), the same mechanism Atlas already
  runs locally for Tier A (`scripts/push-tier-a-crl.sh`). With short-lived certs, the
  CRL only needs to cover a lost Pi *during* its tournament, so it stays tiny.
- Same approach as Tier A inside the venue (`docs/level2.md` §30.5), so there's one
  mental model, one set of tooling patterns, and prior experience with the failure
  modes (`project_device_pairing_tiers` in memory: ACL `pattern` vs `topic`, CRL
  growth, TLS hostname mismatches).
- Cost: the cloud side needs a CA and an issuance step (§6).

### 5.3 Rejected — per-venue (per-Pi) permanent credentials

Scope by *machine* rather than by tournament. It fixes attribution and revocation but
not scope: a machine runs many tournaments over its life, so the ACL can't bind it to
one path without being re-issued per tournament anyway, which is option B with extra
steps. It also fails N2 and makes a lost Pi a permanent liability.

## 6. Issuance — the part that's actually hard

Signing a CSR is the easy part. Deciding **who may get a certificate for which
`tournament_id`** is the hard part, and it changes the spec's reasoning.

§31.3 currently says: *"Global uniqueness without a global registry."* Once the broker
refuses writes outside a credential's own `tournament_id`, whoever issues credentials
*is* the registry: issuing `bel-nat-champ-2026` to one organiser means nobody else can
publish under it. That's probably right for a broker the OpenPiste project runs, but
it is a real change, and the spec should say so rather than keep a claim that's no
longer true for authenticated bridges.

Possible issuance channels, in increasing effort:

1. **Manual.** The organiser runs a script that produces a CSR and sends it to the
   broker operator, who signs it and sends the certificate back. Nothing secret
   travels, so email is fine. Enough for the first dozens of events.
2. **Self-service portal on openpiste.org.** The organiser signs in, enters the
   tournament details, and uploads the CSR (or Atlas submits it directly). The
   certificate is issued automatically or after approval. The portal checks
   `tournament_id` availability, which replaces the script's retained-identity
   collision check.
3. **Federation-delegated.** A national federation gets an intermediate CA constrained
   to its NOC and issues certificates for its own events. That matches §31.3's
   original "a federation maintains its own identifiers" intent, and it matches how
   the topic tree is already partitioned by NOC.

## 7. Details to settle

- **Certificate identity vs. `%u` substitution.** A `tournament_id` is only unique
  within `{NOC}/{date}` under §31.3, but a `%u` pattern can only constrain the one
  segment it substitutes into. Mosquitto refuses to substitute an identity containing
  `/`, `+` or `#` (a guard against ACL escapes; **to verify against the running
  broker version**), so the certificate can't carry the full `BEL/2026/09/25/id`
  path. Options:
  - Make `tournament_id` globally unique at issuance. Simplest, since the issuer is
    now the registry anyway (§6). The NOC/date segments then become pure filter
    dimensions, which is what they already are for subscribers.
  - A CN like `BEL.2026-09-25.bel-nat-champ-2026`, with a small auth plugin that
    checks topic segments against it. That breaks the "just Mosquitto config" property
    on the cloud side, so only if global uniqueness is unacceptable.
- **Validity window vs. the Pi's clock.** A Pi has no RTC (see the `time-sync.target`
  fix in `docs/pi-image-quickstart.md`). `notBefore` should be the issuance time, not
  the tournament start date, since bridges are usually set up the day before.
  `notAfter` should be `end_date` plus a small grace period for late result uploads.
- **Retained cleanup after expiry.** An expired certificate can't clear its own
  retained topics or identity message. The cloud side needs a cleanup job keyed on
  the identity's `end_date`, or retained piste state simply stays as the final
  archived state. That might actually be desirable.
- **Flood protection.** Mosquitto has `message_size_limit` and per-listener
  `max_connections` but no per-client rate limit without a plugin. Attribution (N4)
  at least makes it possible to cut one venue off by CRL. Decide whether that's
  enough.
- **Read side.** Who may *subscribe* on the cloud broker is a separate decision: fully
  public and anonymous read, read-only for registered consumers, or per-federation.
  It belongs in the same ACL file, so it's worth deciding at the same time.
- **Transition.** Keep the shared `bridge` user working (a `--password` mode in the
  script) until certificate issuance exists, then retire it with a date announced in
  advance.

## 8. What would change where

- **Spec (`docs/level2.md` §31, upstream PR):** §31.3's "no global registry"
  paragraph qualified for authenticated bridges. §31.6 gains "a bridge SHOULD
  authenticate to the cloud broker with a credential scoped to its tournament", kept
  deliberately non-prescriptive about mTLS vs. passwords, since other brokers or
  operators may choose differently. Possibly `tournament_id` becomes globally unique
  (§7).
- **Cloud broker (`mqtt.openpiste.org`):** a CA, an mTLS listener with
  `use_identity_as_username`, the `%u` ACL pattern, a CRL, and a cleanup job.
- **Atlas (`scripts/configure-cloud-bridge.sh`):** generate key and CSR, install the
  signed certificate, emit `bridge_certfile`/`bridge_keyfile` instead of
  `remote_username`/`remote_password`. The config file's `broker` block gains cert
  paths. The retained-identity collision check stays as an early, friendly error, but
  the broker becomes the real enforcement.

## 9. Open questions for the next session

1. Issuance channel to start with: manual CSR exchange (§6.1), or go straight to a
   portal?
2. Should `tournament_id` become globally unique (§7)?
3. Cloud read access: public, registered, or per-federation?
4. Should retained state outlive the tournament as an archive, or be cleaned up?

## 10. What this document is not

Not a spec change, and not a plan of record. It records why the shared `bridge` user
is a placeholder, and the recommended direction (per-tournament, short-lived client
certificates, §5.2) with the questions that still need a decision before anything is
built.
