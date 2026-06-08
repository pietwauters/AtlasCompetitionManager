'use strict';

const ROLE_LEVEL = { public: 0, referee: 1, assistant: 1, director: 2, admin: 3 };

// Returns the numeric level of the currently logged-in user (0 = not logged in).
function level(req) {
  return ROLE_LEVEL[req.session?.user?.role] ?? 0;
}

// Middleware: require at least the given role.
// HTML requests redirect to /login; API requests return 401 JSON.
function require(role) {
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

module.exports = { require, level, attach };
