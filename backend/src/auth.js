'use strict';
// Stateless sign-in: a signed JWT (HS256, 8 h) in an httpOnly cookie. The user row is re-read on every
// request, so a login whose password_hash is cleared (or an admin who left) loses access immediately.
const jwt = require('jsonwebtoken');
const { HttpError } = require('./http');

const COOKIE = 'autocare_session';
const TTL_SECONDS = 8 * 60 * 60;

const USER_SQL = `
  SELECT u.id, u.email, u.role, u.customer_id, u.employee_id,
         c.full_name_or_company AS customer_name,
         e.full_name AS employee_name, e.branch_id, b.name AS branch_name,
         (u.employee_id IS NOT NULL AND e.id IS NULL) AS staff_inactive
  FROM app_users u
  LEFT JOIN customers c ON c.id = u.customer_id
  LEFT JOIN employees e ON e.id = u.employee_id AND (e.left_on IS NULL OR e.left_on >= current_date)
  LEFT JOIN branches b  ON b.id = e.branch_id
  WHERE u.id = $1 AND u.password_hash IS NOT NULL`;

async function loadUser(pool, userId) {
  const { rows } = await pool.query(USER_SQL, [userId]);
  const r = rows[0];
  if (!r || r.staff_inactive) return null;
  const scope = r.role === 'customer' ? 'customer' : r.branch_id ? 'branch' : 'hq';
  return {
    id: String(r.id),
    email: r.email,
    role: r.role,
    scope,
    name: r.customer_name || r.employee_name || 'Head office',
    customerId: r.customer_id ? String(r.customer_id) : null,
    branchId: r.branch_id ? String(r.branch_id) : null,
    branchName: r.branch_name || null,
  };
}

function publicUser(u) {
  return {
    id: u.id, email: u.email, role: u.role, scope: u.scope, name: u.name,
    branch: u.branchId ? { id: u.branchId, name: u.branchName } : null,
  };
}

function cookieOptions(config) {
  return { httpOnly: true, secure: config.secure, sameSite: 'lax', path: '/', maxAge: TTL_SECONDS * 1000 };
}

function setSession(res, config, userId) {
  const token = jwt.sign({ sub: String(userId) }, config.jwtSecret, { algorithm: 'HS256', expiresIn: TTL_SECONDS });
  res.cookie(COOKIE, token, cookieOptions(config));
}

function clearSession(res, config) {
  const { maxAge, ...opts } = cookieOptions(config);
  res.clearCookie(COOKIE, opts);
}

// Attaches req.user (or null). Never throws for a bad/expired token: the visitor is just anonymous.
function authenticate(pool, config) {
  return async (req, _res, next) => {
    req.user = null;
    const token = req.cookies?.[COOKIE];
    if (!token) return next();
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    } catch {
      return next();
    }
    if (typeof payload.sub !== 'string' || !/^[0-9]+$/.test(payload.sub)) return next();
    req.user = await loadUser(pool, payload.sub);
    next();
  };
}

const requireAuth = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'Please sign in.')));
const requireCustomer = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Please sign in.'));
  return req.user.role === 'customer' ? next() : next(new HttpError(403, 'Forbidden.'));
};
const requireAdmin = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Please sign in.'));
  return req.user.role === 'admin' ? next() : next(new HttpError(403, 'Forbidden.'));
};

// Branch filter for staff queries: null = all branches (HQ admin).
const branchScope = (user) => (user.scope === 'branch' ? user.branchId : null);

module.exports = {
  COOKIE, loadUser, publicUser, setSession, clearSession, authenticate,
  requireAuth, requireCustomer, requireAdmin, branchScope,
};
