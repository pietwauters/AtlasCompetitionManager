# Implementation notes

Practical "how do you actually build this" guides — a different thing from both
`docs/level2.md` (the spec itself) and the `*-discussion.md` documents (non-normative
reasoning captured *before* something becomes spec language).

An implementation note:
- Assumes the relevant spec section already exists and is settled.
- Shows one concrete way to satisfy it with real, named tools (a specific broker,
  a specific library) — not the only way, and not a requirement. Any implementation
  that satisfies the actual spec text is compliant even if it does it differently.
- Is not authoritative. If a note and the spec ever disagree, the spec wins — fix the
  note, not the other way round.
- Belongs here, not in `docs/level2.md`, precisely because it's implementation-specific
  and the spec deliberately isn't (see `docs/level2.md` §2, "No component may assume
  vendor-specific behaviour from any other").

## Index

- [Mosquitto configuration for OPP2 security](mosquitto-security.md) — plain Mosquitto
  (no plugins) config satisfying §30.2/§30.3's read-open/write-authenticated,
  role-scoped access model, for both Tier A (certs) and Tier B (username/password)
  credentials.
