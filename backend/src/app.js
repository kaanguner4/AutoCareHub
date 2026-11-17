'use strict';
const fs = require('node:fs');
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
  'main.js', 'admin.js', 'style.css', 'admin.css', 'hero.svg'];

// Third-party front-end files, served from the pinned npm packages (no CDN): URL prefix -> package folder.
const NODE_MODULES = path.join(__dirname, '..', 'node_modules');
// Only asset file types are served (no package.json, README, sources).
const VENDOR_ASSET = /\.(css|js|map|woff2?|ttf)$/;
const VENDOR = {
  '/vendor/bootstrap': 'bootstrap/dist',                                    // MIT
  '/vendor/fontawesome/css': '@fortawesome/fontawesome-free/css',           // MIT (code)
  '/vendor/fontawesome/webfonts': '@fortawesome/fontawesome-free/webfonts', // OFL-1.1 (fonts), CC BY 4.0 (icons)
  '/vendor/poppins': '@fontsource/poppins',                                 // OFL-1.1
};

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
        'script-src': ["'self'"],
        'script-src-attr': ["'none'"],
        'style-src': ["'self'"],
        'font-src': ["'self'"],
        'img-src': ["'self'", 'data:'],   // data: for Bootstrap's built-in SVG icons
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
  for (const [prefix, dir] of Object.entries(VENDOR)) {
    const full = path.join(NODE_MODULES, dir);
    if (!fs.existsSync(full)) throw new Error(`Missing front-end package folder ${dir}; run npm ci`);
    const serve = express.static(full, { index: false, dotfiles: 'ignore', maxAge: '7d', redirect: false });
    app.use(prefix, (req, res, next) => (VENDOR_ASSET.test(req.path) ? serve(req, res, next) : next()));
  }
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
