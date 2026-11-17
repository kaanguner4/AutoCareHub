'use strict';
const express = require('express');
const { requireCustomer } = require('../auth');
const { badRequest, notFound, conflict, text, id, int } = require('../http');

const FUELS = ['petrol', 'diesel', 'hybrid', 'ev', 'lpg'];
const COLUMNS = 'id, plate, brand, model, model_year, fuel, mileage_km_at_registration, created_at';

// "34abc123", "34 ABC 123" -> "34 ABC 123"; null if it is not a Turkish plate.
function normalisePlate(raw) {
  const m = /^(\d{2})\s*([A-Za-z]{1,3})\s*(\d{2,4})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const code = Number(m[1]);
  if (code < 1 || code > 81) return null;
  return `${m[1]} ${m[2].toUpperCase()} ${m[3]}`;
}

const shape = (r) => ({ ...r, id: String(r.id) });

// A customer only ever sees and changes their own vehicles; others' ids answer 404.
module.exports = function vehicleRoutes(pool) {
  const router = express.Router();
  router.use('/vehicles', requireCustomer);

  router.get('/vehicles', async (req, res) => {
    const { rows } = await pool.query(
      `SELECT ${COLUMNS} FROM vehicles WHERE customer_id = $1 ORDER BY created_at DESC, id DESC`,
      [req.user.customerId]);
    res.json(rows.map(shape));
  });

  router.get('/vehicles/:id', async (req, res) => {
    const vid = id(req.params.id);
    if (!vid) throw notFound();
    const { rows } = await pool.query(
      `SELECT ${COLUMNS} FROM vehicles WHERE id = $1 AND customer_id = $2`, [vid, req.user.customerId]);
    if (!rows[0]) throw notFound();
    res.json(shape(rows[0]));
  });

  router.post('/vehicles', async (req, res) => {
    const b = req.body ?? {};
    const brand = text(b.brand, { min: 1, max: 40 });
    const model = text(b.model, { min: 1, max: 60 });
    const plate = normalisePlate(b.plate);
    const year = int(b.model_year, { min: 1990, max: new Date().getFullYear() + 1 });
    const fuel = FUELS.includes(b.fuel) ? b.fuel : null;
    const mileage = b.mileage_km === undefined || b.mileage_km === '' ? 0 : int(b.mileage_km, { min: 0, max: 2_000_000 });
    if (!brand || !model) throw badRequest('Please enter the brand and model.');
    if (!plate) throw badRequest('Please enter a Turkish plate, e.g. 34 ABC 123.');
    if (!year) throw badRequest('Please enter a valid model year.');
    if (!fuel) throw badRequest('Please choose the fuel type.');
    if (mileage === null) throw badRequest('Please enter a valid mileage.');
    try {
      const { rows } = await pool.query(
        `INSERT INTO vehicles (customer_id, plate, brand, model, model_year, fuel, mileage_km_at_registration, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING ${COLUMNS}`,
        [req.user.customerId, plate, brand, model, year, fuel, mileage]);
      res.status(201).json(shape(rows[0]));
    } catch (err) {
      if (err.code === '23505') throw conflict('This plate is already registered.');
      throw err;
    }
  });

  router.delete('/vehicles/:id', async (req, res) => {
    const vid = id(req.params.id);
    if (!vid) throw notFound();
    try {
      const { rowCount } = await pool.query(
        'DELETE FROM vehicles WHERE id = $1 AND customer_id = $2', [vid, req.user.customerId]);
      if (rowCount === 0) throw notFound();
    } catch (err) {
      if (err.code === '23503') throw conflict('This vehicle has appointments or service history and cannot be deleted.');
      throw err;
    }
    res.json({ message: 'Vehicle deleted.' });
  });

  return router;
};

module.exports.normalisePlate = normalisePlate;
