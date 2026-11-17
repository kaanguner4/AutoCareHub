'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { authenticate } = require('./auth');
const { HttpError } = require('./http');
const authRoutes = require('./routes/auth');
const catalogRoutes = require('./routes/catalog');
const vehicleRoutes = require('./routes/vehicles');
const appointmentRoutes = require('./routes/appointments');
const adminRoutes = require('./routes/admin');

// The only files the web server hands out (the repo root also holds .env, seed data, ...).
const PUBLIC_FILES = ['index.html', 'register.html', 'dashboard.html', 'appointment.html', 'admin.html',
  'main.js', 'admin.js', 'style.css'];

const GENERIC_ERROR = 'Something went wrong. Please try again.';

/**
 * @param {object} config  from config.load()
 * @param {import('pg').Pool} pool
 * @param {{loginLimit?: number}} [options]
 */
function createApp(config, pool, options = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", 'https://cdn.jsdelivr.net'],
        'script-src-attr': ["'none'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com',
          'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'data:', 'https://cdnjs.cloudflare.com', 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'https://content-hub.imgix.net'],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': config.secure ? [] : null,
      },
    },
    strictTransportSecurity: config.secure,
  }));

  // Every state-changing request must come from the app's own origin (CSRF defence next to SameSite=Lax).
  app.use((req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('origin') !== config.appOrigin) return next(new HttpError(403, 'Forbidden.'));
    return next();
  });

  app.use('/api', cors({ origin: config.appOrigin, credentials: true }));
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser());

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use('/api', authenticate(pool, config));
  app.use('/api', authRoutes(pool, config, options));
  app.use('/api', catalogRoutes(pool));
  app.use('/api', vehicleRoutes(pool));
  app.use('/api', appointmentRoutes(pool));
  app.use('/api', adminRoutes(pool));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  const sendPage = (name) => (_req, res, next) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(config.staticDir, name), (err) => {
      if (err && !res.headersSent) next(err.code === 'ENOENT' ? new HttpError(404, 'Not found.') : err);
    });
  };
  app.get('/', sendPage('index.html'));
  for (const name of PUBLIC_FILES) app.get(`/${name}`, sendPage(name));

  app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

  // Errors: log server-side, send only a fixed message (never err.message, SQL or stack).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.publicMessage });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    console.error(`${req.method} ${req.path} failed:`, err);
    return res.status(500).json({ error: GENERIC_ERROR });
  });

  return app;
}

module.exports = { createApp, PUBLIC_FILES };
