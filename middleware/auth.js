'use strict';

const User = require('../services/users');

const ROLE_LEVEL = { public: 0, referee: 1, assistant: 1, director: 2, admin: 3 };

// Paths a logged-in user must still be able to reach even while force_pin_change
// is set — the change-pin page itself, its API, and the shared static assets it
// needs to render (style.css etc).
const PIN_GATE_ALLOWED_PATHS = new Set(['/change-pin.html', '/login.html', '/favicon.ico']);
const PIN_GATE_ALLOWED_PREFIXES = ['/api/auth/', '/css/', '/js/', '/img/'];

// Returns the numeric level of the currently logged-in user (0 = not logged in).
function level(req) {
  return ROLE_LEVEL[req.session?.user?.role] ?? 0;
}

// Middleware: require at least the given role.
// HTML requests redirect to /login; API requests return 401 JSON.
// Named requireRole (not `require`) internally — a function declaration named
// `require` hoists and shadows Node's own require() for this whole module,
// which broke the top-of-file require('../services/users') above the first
// time this file needed a real require() call. Exported as `require` below so
// every existing call site (auth.require(role)) is unaffected.
function requireRole(role) {
  const needed = ROLE_LEVEL[role] ?? 99;
  return (req, res, next) => {
    if (level(req) >= needed) return next();
    const isApi = req.originalUrl.startsWith('/api/') || req.headers.accept?.includes('application/json');
    if (isApi) return res.status(401).json({ error: `Not authorised — ${role} role required`, role });
    res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
  };
}

// Middleware: attach user info to res.locals for use in any handler.
function attach(req, _res, next) {
  // req.session.user is set on login; null for unauthenticated requests.
  next();
}

// Middleware: while a logged-in user's force_pin_change flag is still set (a
// freshly created account, or one an admin reset), block everything except the
// change-pin page/API until they clear it. login.html's client-side redirect on
// login (see routes/auth.js's forcePin field) covers the normal first-login
// path, but that's a one-time redirect suggestion, not an enforced gate — a
// session cookie from an earlier login (e.g. still valid in the browser from a
// previous test run against the same SESSION_SECRET) would otherwise skip it
// entirely and land straight in the app with the PIN never actually changed.
// Re-reads force_pin_change fresh from the DB every request rather than trusting
// req.session.user (which only ever carries id/role/username) — this is also
// what makes it self-correcting once the PIN is actually changed, with no need
// to touch the session itself.
function requirePinChange(req, res, next) {
  if (!req.session.user) return next();

  const path = req.path;
  if (PIN_GATE_ALLOWED_PATHS.has(path) || PIN_GATE_ALLOWED_PREFIXES.some(p => path.startsWith(p))) {
    return next();
  }

  const user = User.findById(req.session.user.id);
  if (!user || user.force_pin_change !== 1) return next();

  const isApi = req.originalUrl.startsWith('/api/') || req.headers.accept?.includes('application/json');
  if (isApi) return res.status(403).json({ error: 'PIN change required before continuing', forcePin: true });
  return res.redirect('/change-pin.html');
}

module.exports = { require: requireRole, level, attach, requirePinChange };
