'use strict';
const { Pool } = require('pg');

function createPool(dbConfig) {
  const pool = new Pool({
    ...dbConfig,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: 'autocare-web',
  });
  pool.on('error', (err) => console.error('pg pool error', err));
  return pool;
}

// Run fn(client) inside a transaction.
async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPool, withTransaction };
