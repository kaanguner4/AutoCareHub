'use strict';
const config = require('./config').load();
const { createPool } = require('./db');
const { createApp } = require('./app');

const pool = createPool(config.db);
const app = createApp(config, pool);
const server = app.listen(config.port, () => {
  console.log(`AutoCare web listening on port ${config.port} (origin ${config.appOrigin})`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
