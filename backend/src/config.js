'use strict';
// All configuration comes from the environment (docker compose passes the values from .env).
const path = require('node:path');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function parseTrustProxy(raw) {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw; // e.g. "loopback" or a subnet list
}

function load() {
  const appOrigin = new URL(process.env.APP_ORIGIN || 'http://localhost:3000').origin;
  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 32 || jwtSecret.startsWith('change-me')) {
    throw new Error('JWT_SECRET must be a random value of at least 32 characters');
  }
  return {
    port: Number(process.env.PORT || 3000),
    appOrigin,
    secure: appOrigin.startsWith('https://'),
    jwtSecret,
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    staticDir: path.resolve(process.env.STATIC_DIR || path.join(__dirname, '..', '..')),
    db: {
      host: process.env.PGHOST || 'db',
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || 'autocare',
      user: process.env.PGUSER || 'autocare_app',
      password: required('AUTOCARE_APP_PASSWORD'),
    },
  };
}

module.exports = { load };
