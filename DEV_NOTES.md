# AtlasCompetitionManager — Development Notes

This file is updated as decisions are made. It is the living record of *why*,
not just *what*. Ordered newest-first within each section.

---

## Technology decisions

### 2026-04-13 — Initial stack selection

**Runtime: Node.js + Express**
- Same platform as the companion `mqtt-web` scoring display project.
- Runs on Raspberry Pi (arm64/armv7) without extra setup.
- Large ecosystem, familiar to the team.

**Database: SQLite via `better-sqlite3`**
- Zero server process — single file, trivial to back up on Pi.
- Synchronous driver simplifies code for a single-server, competition-day deployment.
- Upgrade path to PostgreSQL exists by swapping driver + dialect if scale requires it.
- DB file lives in `data/atlas.db` (gitignored; created by `install.sh`).

**Frontend: HTMX + Alpine.js (no build step)**
- No transpiler, no bundler — CDN `<script>` tags only.
- HTMX handles server-driven partial updates (table refreshes, bracket updates).
- Alpine.js adds local reactivity (dropdowns, toggles, drag-and-drop).
- Consistent with `mqtt-web` style (plain HTML files served statically).

**Real-time push: Server-Sent Events (SSE)**
- Simpler than WebSockets for server→browser updates.
- Native browser support, trivial to emit from Express.
- Integration path: MQTT scoring machines → Mosquitto → `server.js` → SSE → browser.

**Authentication: `express-session` + `bcryptjs`**
- Session-based auth, no third-party identity provider.
- Roles: `superadmin`, `admin`, `referee`, `viewer`.
- Session secret read from `SESSION_SECRET` env var (must be set in production).

**Competition rules: JSON files in `rules/`**
- Each rule file describes a phase: pool formation algorithm, advancement criteria,
  seeding formula, bout parameters.
- Adding a new competition format = writing a new JSON file, not changing code.
- Format chosen over XML for native Node.js fit.

**Process management: PM2**
- Same as `mqtt-web`.
- `install.sh` / `StartAtBoot.sh` / `DontStartAtBoot.sh` follow the identical pattern.

**Deployment target**
- Primary: Raspberry Pi (arm64 / armv7l) running Raspberry Pi OS (Debian-based).
- Secondary: any Linux laptop/desktop.
- Development: local machine, `node server.js`, port 3000.

---

## Architecture

```
Browser (HTMX + Alpine)
        │  REST + SSE
   Express (Node.js, port 3000)
   ├── SQLite  (data/atlas.db)
   ├── Rule engine (loads rules/*.json)
   └── SSE broadcaster
        │
   Mosquitto MQTT broker  ←── Scoring machines (mqtt-web / Cyrano)
```

---

## Out of scope for MVP

- FIE Engarde import/export
- Multi-machine distributed deployment
- Mobile native app
- Automated referee scheduling
- SSL (use a reverse proxy like nginx for production HTTPS)

---

## Key URLs (development)

| Path | Purpose |
|------|---------|
| `http://localhost:3000/` | Dashboard home |
| `http://localhost:3000/health` | Health check JSON |

---

## Schema change log

| Date | Change | Reason |
|------|--------|--------|
| 2026-04-13 | Initial schema | Bootstrap |
