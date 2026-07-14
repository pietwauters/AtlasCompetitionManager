# Mosquitto configuration for OPP2 security

> Implementation note — non-normative, see [README](README.md). Shows one concrete way
> to satisfy `docs/level2.md` §30.2 ("read is always open, write is always
> authenticated") and §30.3 ("each publisher role MUST be restricted, at the broker, to
> publishing only within its own topic namespace") using stock Mosquitto, no plugins.
> Any broker that actually satisfies those two requirements is compliant — this is not
> the standard, and Mosquitto's Dynamic Security plugin is deliberately not used here
> (vendor-specific; see `docs/level2.md` §2 and `docs/security-provisioning-discussion.md`
> for why).

## The core idea

Mosquitto has no built-in concept of a "role." All it knows, per connection, is an
authenticated principal — a username (from `password_file`) or a certificate CN (from
`use_identity_as_username`) — and a set of topic patterns that principal may read or
write, from `acl_file`. Everything below is just: turn each of OPP2's five publisher
roles (`apparatus`, `software`, `remote`, `var`, `scoresheet`) into ACL stanzas keyed on
whichever credential a given device holds. Mosquitto does the enforcement; OPP2's role
model exists only in how the ACL file is written.

## 1. Keep reads global, put every write inside a credential

```conf
# /etc/mosquitto/acl.conf

# global — applies to every connection, authenticated or anonymous
topic read #
```

No `topic write` line goes here. Every `topic write` rule from here on lives inside a
`user <name>` block. This is what makes §30.2's asymmetry fall out for free:
`allow_anonymous true` still lets a pure read-only client (a live piste display with no
credentials at all) connect and subscribe to anything, because the global block covers
it — but since it never matches any `user` block, it never gets write access to
anything. No separate "read-only role" needs to exist; it's just the absence of a
credential.

**Confirmed the hard way, 2026-07-14 — this global `topic read #` line only reaches
truly anonymous connections.** On Mosquitto 2.0.18, a client that authenticates with a
username gets *only* whatever appears inside its own `user <name>` block — the global,
unscoped lines above it are not inherited. The `SUBACK` for a disallowed subscription
still comes back successful, which is what makes this easy to miss: nothing errors,
messages (retained or live) just never arrive. Verified directly against a real
deployment: an authenticated device with a correctly-provisioned password could
subscribe successfully but received nothing, while the identical subscribe worked
instantly anonymous. **Consequence: every `user` block below needs its own explicit
`topic read #` line too**, not just the write line — every example in this note has
been corrected to include it.

## 2. Tier B — username/password, one per device

```bash
mosquitto_passwd -b /etc/mosquitto/passwd apparatus_piste07 '<generated-password>'
```

```conf
user apparatus_piste07
topic read #
topic write openpiste/+/apparatus/#
```

One stanza per device credential, matching §30.6's pre-generated pool. There is no
prefix/wildcard matching on usernames in an ACL file — you cannot write a single rule
that says "anyone named `apparatus_*` gets apparatus write access." Whatever creates the
credential (the pool-generation script) has to also emit the matching ACL stanza at the
same time; the two are generated together, not derived from each other later.

## 3. Tier A — client certificates

```conf
listener 8883
cafile /etc/mosquitto/certs/ca.crt
certfile /etc/mosquitto/certs/server.crt
keyfile /etc/mosquitto/certs/server.key
require_certificate true
use_identity_as_username true
```

With `use_identity_as_username true`, the certificate's CN becomes the ACL username
automatically — no separate password, and the exact same per-user ACL stanza mechanism
from §2 applies unchanged:

```conf
user scoresheet-device-014
topic read #
topic write openpiste/+/scoresheet/#
```

Atlas's own CA at `data/tls/` (`scripts/generate-tls-cert.sh`,
`scripts/install-broker-cert.sh`) is already the right shape to issue these — a
device's CSR response (§30.5) just needs its `role` field to end up as (or be encoded
in) the cert's CN, so the provisioning step that signs it can also write the matching
ACL stanza.

## 4. Multiple listeners, different auth per listener

Atlas's broker already runs several listeners (1883 plain, 8883 TLS, 9001 `ws`, 9002
`wss` — see CLAUDE.md's OPP2 section). `per_listener_settings true` lets each one set
its own `allow_anonymous`/`require_certificate` independently — e.g. 8883 could require
a client cert (Tier A only), while 1883 stays anonymous-read / password-file-write for
everything else. `acl_file` itself is not per-listener: one file, evaluated by
authenticated identity regardless of which listener a client came in on, covers all of
them.

## 5. Applying changes — no live API, and that's fine

Nothing here needs Mosquitto's Dynamic Security plugin or a webhook (§7 covers that
plugin as an optional, Mosquitto-specific alternative — worth reading, but not required
for anything above). The provisioning flow just appends to `passwd`/`acl_file` (or, for
Tier A, signs a cert and appends the matching stanza), then:

```bash
kill -HUP "$(pidof mosquitto)"
```

Mosquitto reloads `password_file` and `acl_file` on `SIGHUP` without dropping
already-connected clients. This matches §30.6's "creation can be batch/offline,
assignment is the only thing that needs to be fast" split — reload is cheap and quick
enough to run per-device if needed, but nothing requires a broker capable of live user
management.

## 6. Revocation

- **Tier A:** put the device's certificate on the CRL (§30.5). The TLS handshake itself
  then refuses the connection — no ACL file change needed at all.
- **Tier B:** delete the credential's line from `passwd` and its stanza from
  `acl_file`, then `SIGHUP`. An already-connected session is not force-disconnected by
  this alone; if immediate disconnection matters, follow with a targeted
  `mosquitto_ctrl` kick or a broker restart.

## 7. An alternative: Mosquitto's Dynamic Security plugin

> **Mosquitto-specific.** Everything in §1–§6 works against any broker that implements
> plain MQTT ACLs the standard way. This section is an optional Mosquitto extra — it
> doesn't change what the spec requires, only how easy §1–§6's model is to *operate* on
> this one broker, and it comes with real gaps of its own (below). Not chosen as this
> note's baseline, for the same reason `docs/level2.md` §2 gives for avoiding it in the
> spec itself: leaning on it would make the ACL model depend on a mechanism only one
> broker vendor ships. Confirmed against Mosquitto's own documentation
> (`mosquitto.org/documentation/dynamic-security/`) and a detailed third-party writeup
> with real user-reported experience
> (`steves-internet-guide.com/understanding-mosquitto-dynamic-security-plugin/`),
> 2026-07-14.

Where §1–§6 write one ACL stanza per device — because plain `acl_file` has no notion of
a reusable permission set — Mosquitto also ships an official plugin,
`mosquitto_dynamic_security.so`, with a genuine **Role** object: a named bundle of ACL
entries, assignable to a **Group**, with **Clients** (devices) added to a group rather
than having the topic pattern retyped per device. This maps onto OPP2's role model
unusually well — one Role per publisher role, created once:

```
mosquitto_ctrl dynsec createRole apparatus-publisher
mosquitto_ctrl dynsec addRoleACL apparatus-publisher publishClientSend "openpiste/+/apparatus/#" allow
mosquitto_ctrl dynsec createGroup apparatus-devices
mosquitto_ctrl dynsec addGroupRole apparatus-devices apparatus-publisher
```

— then every new device is just a `createClient` + `addGroupClient` into
`apparatus-devices`; no ACL pattern gets retyped per device the way §2's per-user
stanzas require. Two more genuine advantages over §1–§6's plain-file approach,
confirmed from Mosquitto's documentation:

- **Anonymous read is a first-class concept, not a global-ACL-file trick.** A built-in
  `unauthenticated` group exists, and `mosquitto_ctrl dynsec setAnonymousGroup
  <groupname>` assigns it whatever role anonymous connections should have — a direct,
  explicit match for §30.2's "read is always open," instead of relying on §1's "just
  don't put a `user` block around it" convention.
- **Changes are live and immediate, including for already-connected sessions.**
  Disabling or deleting a client disconnects any session currently using those
  credentials right away — closing the exact gap §6 flags above (`SIGHUP` alone does
  *not* force-disconnect an existing session).

**Confirmed, not just inferred:** `allow_anonymous true` is still the gate at the
listener level — dynsec's `unauthenticated` group only ever applies to a connection
that was let in without credentials in the first place. Straight from the source:
"If allow anonymous is disabled then the connection must supply a valid username and
password." Same relationship `acl_file` has with it in §1, now confirmed rather than
assumed.

### Real gaps

- **No documented certificate support.** Dynamic Security's client store is
  username/password only in the published documentation; §3's Tier A approach
  (`require_certificate` + `use_identity_as_username`) is never mentioned in either
  source consulted here. Whether a TLS client-certificate identity even reaches dynsec's
  authorization check is unconfirmed — don't assume Tier A works with this plugin
  without testing it directly.
- **Mosquitto's own docs recommend `per_listener_settings false`** ("all listeners use
  the same authentication and access control") for this plugin — in direct tension with
  §4's per-listener split (TLS-only on 8883, password-file elsewhere). Running Dynamic
  Security globally while still wanting listener-specific TLS requirements needs
  hands-on verification; it may not be possible to have both cleanly at once.
- **`%c`/`%u` pattern substitution does not reliably work inside dynsec's own ACL
  types**, despite the official docs describing it for `publishClientSend` and
  `subscribePattern`. Real-world reports say otherwise: "Can I use the %u and %c syntax
  like in the old ACL file? — It doesn't appear so," confirmed independently by several
  readers over 2023–2025 hitting the same wall trying to restrict a client to publish
  only under its own topic segment. One documented workaround runs the classic
  `acl_file` *alongside* the plugin — dynsec supplies deny-by-default via its roles, and
  any ACL type left unconfigured in dynsec falls through to `acl_file`, which still
  supports `%c`/`%u` the old way. Directly relevant to the still-open
  per-piste/per-instance-scoping question (`docs/security-provisioning-discussion.md`
  §5) if it's ever pursued through this plugin — verify hands-on rather than trusting
  the official docs' claim here.

**Bottom line:** genuinely worth adopting for Tier B credential management specifically
— the Role/Group model removes real per-device duplication, gives immediate
one-command revocation, and makes anonymous read an explicit first-class setting rather
than an ACL-file convention. Set against that, an experienced practitioner's own
verdict is a useful counterweight: "Unless your ACL permissions change frequently then
I think you would be better with the old files." Atlas's use case — provisioning and
revoking individual device credentials continuously over a competition's lifetime — is
arguably exactly the "changes frequently" case this favors, but the unconfirmed
certificate gap and the `per_listener_settings` conflict mean it likely can't cleanly
replace §1–§6 wholesale on a broker that also serves Tier A devices. Treat it as a
possible supplement to the Tier B parts of this note, not a full replacement, until the
open gaps above are tested hands-on.

## Worked example

```conf
# /etc/mosquitto/conf.d/opp2-security.conf
per_listener_settings true

listener 1883
allow_anonymous true
password_file /etc/mosquitto/passwd

listener 8883
allow_anonymous false
cafile /etc/mosquitto/certs/ca.crt
certfile /etc/mosquitto/certs/server.crt
keyfile /etc/mosquitto/certs/server.key
require_certificate true
use_identity_as_username true

acl_file /etc/mosquitto/acl.conf
```

```conf
# /etc/mosquitto/acl.conf
topic read #

user apparatus_piste07
topic read #
topic write openpiste/+/apparatus/#

user remote_014
topic read #
topic write openpiste/+/remote/#

user scoresheet-device-014
topic read #
topic write openpiste/+/scoresheet/#
```

(The CMS's own `software` publisher and any `var` publisher get the same treatment —
one `user` stanza each, omitted here for brevity.)

## What this note doesn't cover

- Per-piste/per-instance scoping beyond role (e.g. restricting a credential to
  `openpiste/07/...` specifically) — an open question, see
  `docs/security-provisioning-discussion.md` §5. The natural mechanism, if it's ever
  needed, is Mosquitto's `%u` topic-pattern substitution rather than anything above.
- Any broker other than Mosquitto — the spec is broker-agnostic on purpose.
- Automating the provisioning exchange itself (generating the credential *and* the
  matching ACL stanza together, on request). That's Atlas's own implementation work,
  not yet rebuilt to match the converged Tier A/B design — see
  `docs/security-provisioning-discussion.md`'s status note.
