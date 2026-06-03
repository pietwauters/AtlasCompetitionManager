# Security and Roles

This document records the design decisions for authentication, authorisation,
and personalised views in Atlas. It is the authoritative reference before
implementing any access-control feature.

---

## Context

Atlas runs on a Raspberry Pi on a local competition-day network. It is not
directly internet-facing; any cloud connectivity goes through a managed bridge
(e.g. Mosquitto MQTT bridge). Concurrent user volumes are small — a single
Node.js process on a Pi is sufficient.

Two distinct concepts must be kept separate throughout the design:

- **Authentication / Authorisation** — proves identity and grants write access.
  Required for Referee, Director, and Admin roles.
- **Personalised views** — filtered read-only pages for fencers and coaches.
  Uses identification (QR code), not authentication. No write access is ever granted.

---

## Roles

### Access matrix

| Capability | Public | Assistant | Referee | Director | Admin |
|---|:---:|:---:|:---:|:---:|:---:|
| View pools, results, bracket, schedule | ✓ | ✓ | ✓ | ✓ | ✓ |
| View own assignment / schedule | — | — | ✓ | ✓ | ✓ |
| Check in / withdraw competitors | — | ✓ | — | ✓ | ✓ |
| Correct people records (limited) | — | ✓ | — | ✓ | ✓ |
| Enter / confirm bout scores | — | — | ✓ | ✓ | ✓ |
| Electronic scoresheet (future) | — | — | ✓ | ✓ | ✓ |
| Create / manage phases | — | — | — | ✓ | ✓ |
| Close / reopen competitions | — | — | — | ✓ | ✓ |
| Manage competitors, seeding | — | — | — | ✓ | ✓ |
| Full people / fencers DB management | — | — | — | — | ✓ |
| OPP2 / MQTT configuration | — | — | — | — | ✓ |
| Strips configuration | — | — | — | — | ✓ |
| User account management | — | — | — | — | ✓ |
| System settings | — | — | — | — | ✓ |

### Role notes

- **Public** — no login; anyone on the network. Read-only pages only.
- **Assistant** — entrance desk staff. Check-in, withdrawals, and limited
  people record corrections (see below). Global scope — not restricted to
  a single competition. QR+PIN authentication, never shared accounts.
- **Referee** — must be linked to an existing record in the `referees` table.
  Cannot exist as a standalone account. Phase-scoped session.
- **Director** — multiple accounts allowed (chief director + assistants).
  Not required to be linked to a people record.
- **Admin** — full access including OPP2 and user management. Should be at
  most one or two people.

### Assistant: people record correction scope

Assistants can correct existing records at the entrance desk. They cannot
create or delete people records.

| Field | Assistant access | Notes |
|---|---|---|
| `first_name`, `last_name` | ✓ Edit freely | Spelling errors |
| `nationality`, `club_id` | ✓ Edit freely | Registration errors |
| `weapons` | ✓ Edit freely | Wrong weapon at registration, or last-minute weapon change |
| `date_of_birth` | ⚠ Edit + flag | Affects age category eligibility — change is saved but logged and shown as pending review to Director/Admin |
| `gender` | ⚠ Edit + flag | Same reason |
| `ranking`, `licence` | ✗ Read-only | Admin only |
| Create new person | ✗ Blocked | Admin only |
| Delete person | ✗ Blocked | Admin only |

Flagged changes appear in a "Pending corrections" list visible to Director
and Admin, who can acknowledge or revert them.

---

## Personalised views (identification, not authentication)

Fencers and coaches get filtered read-only views without a login. Access is
via a QR code that encodes a token pointing to their Atlas person record.

**What a fencer sees:** own pool assignment, next bout, personal results.
**What a coach sees:** schedule and results of all their registered fencers.

These views are **not** a security boundary — they are a UX convenience.
The underlying data is already public; the QR just pre-filters it.
No write access is ever granted through a personalised view.

**URL shape:** `/me/{token}` where `token` is an opaque random string stored
in `people.view_token`. The token is generated when the QR is printed and
never changes unless explicitly rotated by an admin.

**Future upgrade path:** a person who holds both a personalised view token and
an authenticated role (e.g. a fencer who is also a referee) can have their QR
code escalate to full login. This is not implemented now — the personalised
view and the auth system remain separate until that feature is built.

---

## Authentication

### Method: QR code + PIN

All authenticated roles (Referee, Director, Admin) use **QR code + PIN**:

1. User scans the QR code on their accreditation badge.
2. QR encodes a URL: `atlas:3001/login?user={user_token}` — pre-fills the
   username field.
3. User enters their numeric PIN (minimum 6 digits).
4. On success, a session is created.

The QR code on the badge is the same token used for the personalised view
(`people.view_token`) — one badge serves both purposes. For people without
an Atlas user account the QR opens the personalised view. For those with an
account it opens the login screen.

PIN is stored as a bcrypt hash (package already installed). Minimum 6 digits.
Admin can reset any PIN; the new PIN is shown once and must be changed on
first use.

### Admin bootstrap

The admin account is created by `install.sh`:

1. A random 12-character alphanumeric password is generated and printed
   **once** to the console at the end of install. It is never stored in
   plaintext.
2. A `force_password_change` flag is set on the account.
3. On first login, Atlas redirects to a mandatory password-change screen
   before allowing any other action.
4. After the admin changes their password they should immediately create their
   own QR+PIN credentials via the user management screen.

---

## Session management

### Session duration by role

| Role | Session scope |
|---|---|
| Admin | Fixed duration (e.g. 8 hours) or explicit logout. Configurable. |
| Director | Fixed duration (competition day, e.g. 12 hours). |
| Assistant | Fixed duration (competition day, e.g. 12 hours). |
| Referee | **Phase-scoped** — session expires automatically when all bouts assigned to that referee in the current phase are marked done. Referee must re-authenticate for the next phase. |

### Referee phase-scoped sessions

When a referee's session expires (all their bouts in the phase are done),
they are shown a neutral screen: "Phase complete. Await instructions."
They are not logged out to the public homepage — they need to re-authenticate
for the next phase without disrupting their workflow.

If a referee has no assigned bouts in a phase (e.g. they are a reserve), their
session does not expire automatically — only on explicit logout or admin
invalidation.

### Session storage

`express-session` with SQLite session store (consistent with the rest of the
stack — no Redis dependency). Session secret from `.env`.

---

## User account storage

New table `users`:

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `person_id` | INTEGER FK → people | NULL for Director/Admin without a people record |
| `role` | TEXT | `'admin'` \| `'director'` \| `'assistant'` \| `'referee'` |
| `username` | TEXT UNIQUE | Human-readable handle; pre-filled from QR at login |
| `user_token` | TEXT UNIQUE | Opaque token encoded in QR code |
| `pin_hash` | TEXT | bcrypt hash of PIN |
| `force_pin_change` | INTEGER | 1 = must change PIN before proceeding |
| `created_at` | TEXT | ISO timestamp |
| `last_login_at` | TEXT | ISO timestamp |

`people.view_token` is a separate column (for the personalised view QR) and
may or may not share the same value as `users.user_token`. If the person has
a `users` record, both tokens are the same (one badge, two uses). If not,
only `view_token` exists.

---

## QR code generation and printing

QR codes are generated inside Atlas (no external service):
- Admin prints accreditation badges from a dedicated page: `/admin/accreditations`
- Each badge shows name, role, and a QR code
- QR encodes the full URL: `http://{atlas_hostname}:3001/login?u={user_token}`
  (or `/me/{view_token}` for people without accounts)
- If linked to an FIE accreditation import (future), the FIE `PictureUrl`
  can be printed on the badge

---

## GDPR constraints

- `date_of_birth` and `licence` are never rendered on public pages.
- Public result pages show: name, nationality, club, rank, score — nothing else.
- The people management pages (`/people.html`, `/admin/*`) are Admin-only.
- Personalised view pages show only data relevant to that person — no other
  fencers' DOB or licence is ever exposed.

---

## Page-level access control (summary)

| Page / endpoint | Minimum role |
|---|---|
| `/`, `/results.html`, `/pool.html`, `/de.html` | Public |
| `/me/{token}` | None (token = identity) |
| `/phase.html`, `/competition-detail.html` (read) | Public |
| Check-in / withdrawal endpoints | Assistant |
| Limited people record correction | Assistant |
| Score entry endpoints | Referee |
| Phase creation, competition management | Director |
| `/people.html`, `/admin.html` | Admin |
| `/opp2.html`, `/strips.html` | Admin |
| `/admin/accreditations` | Admin |

---

## Closed decisions

| # | Question | Decision |
|---|---|---|
| O1 | Forgotten PIN: self-service or admin reset? | Admin-only reset. No email/SMS on a local Pi. Admin resets → PIN shown once → forced change on next login. |
| O2 | Badge printing: browser print dialog or PDF? | Browser print dialog with print-optimised CSS. No PDF dependency. |
| O3 | Directors linkable to people records? | Optional. A director who is also in the people DB can be linked, but it is not required. |
| O4 | Multi-device referee login: invalidate first session? | Concurrent sessions allowed — a referee may scan accidentally on two devices. Admin can view and manually invalidate active sessions. |
