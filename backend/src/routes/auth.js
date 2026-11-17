'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');

const { withTransaction } = require('../db');
const { loadUser, publicUser, setSession, clearSession, requireAuth } = require('../auth');
const { HttpError, badRequest, conflict, text } = require('../http');

const BCRYPT_COST = 12;
// Compared against when the e-mail is unknown, so a wrong e-mail takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;

function limiter(limit, windowMs, message) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: message }),
  });
}

module.exports = function authRoutes(pool, config, options = {}) {
  const router = express.Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: options.loginLimit ?? 10,           // failed attempts per IP per 15 minutes
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many sign-in attempts. Please try again later.' }),
  });
  const registerLimiter = limiter(options.registerLimit ?? 20, 60 * 60 * 1000,
    'Too many registrations. Please try again later.');

  router.post('/register', registerLimiter, async (req, res) => {
    const body = req.body ?? {};
    const name = text(body.name, { min: 2, max: 100 });
    const email = text(body.email, { min: 5, max: 254 })?.toLowerCase();
    const phone = text(body.phone, { min: 7, max: 20 });
    const city = text(body.city, { min: 2, max: 40 });
    const password = typeof body.password === 'string' ? body.password : '';
    if (!name) throw badRequest('Please enter your full name.');
    if (!email || !EMAIL_RE.test(email)) throw badRequest('Please enter a valid e-mail address.');
    if (!phone || !PHONE_RE.test(phone)) throw badRequest('Please enter a valid phone number.');
    if (password.length < 8 || Buffer.byteLength(password) > 72) {
      throw badRequest('The password must be 8 to 72 characters long.');
    }
    const { rows: cities } = await pool.query('SELECT 1 FROM branches WHERE city = $1 LIMIT 1', [city]);
    if (!city || cities.length === 0) throw badRequest('Please choose your city.');

    const hash = await bcrypt.hash(password, BCRYPT_COST);
    try {
      await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO customers (type, full_name_or_company, phone, email, city, created_at, marketing_opt_in)
           VALUES ('individual', $1, $2, $3, $4, now(), false) RETURNING id`,
          [name, phone, email, city]);
        await client.query(
          `INSERT INTO app_users (customer_id, email, password_hash, role, created_at)
           VALUES ($1, $2, $3, 'customer', now())`,
          [rows[0].id, email, hash]);
      });
    } catch (err) {
      if (err.code === '23505') throw conflict('This e-mail address is already registered.');
      throw err;
    }
    res.status(201).json({ message: 'Registration successful.' });
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const email = text(req.body?.email, { min: 3, max: 254 })?.toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    let row = null;
    if (email && password && Buffer.byteLength(password) <= 72) {
      const { rows } = await pool.query(
        'SELECT id, password_hash FROM app_users WHERE email = $1 AND password_hash IS NOT NULL', [email]);
      row = rows[0] ?? null;
    }
    const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
    const user = ok && row ? await loadUser(pool, row.id) : null;
    if (!user) throw new HttpError(401, 'Invalid e-mail or password.');
    setSession(res, config, user.id);
    res.json({ user: publicUser(user) });
  });

  router.post('/logout', (_req, res) => {
    clearSession(res, config);
    res.json({ message: 'Signed out.' });
  });

  router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

  return router;
};
