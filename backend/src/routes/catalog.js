'use strict';
const express = require('express');

// Public reference data used by the booking and registration forms.
module.exports = function catalogRoutes(pool) {
  const router = express.Router();

  router.get('/services', async (_req, res) => {
    const { rows } = await pool.query(`
      SELECT s.id, s.code, s.name, s.category, s.standard_labor_hours, p.list_price_try
      FROM service_catalog s
      JOIN service_prices p ON p.service_id = s.id
                           AND p.valid_from <= current_date
                           AND (p.valid_to IS NULL OR p.valid_to >= current_date)
      WHERE s.active
      ORDER BY s.category, s.code`);
    res.json(rows.map((r) => ({
      id: String(r.id), code: r.code, name: r.name, category: r.category,
      standard_labor_hours: Number(r.standard_labor_hours), list_price_try: Number(r.list_price_try),
    })));
  });

  router.get('/branches', async (_req, res) => {
    const { rows } = await pool.query(`
      SELECT id, name, city, district FROM branches
      WHERE opened_on <= current_date AND (closed_on IS NULL OR closed_on > current_date)
      ORDER BY city, name`);
    res.json(rows.map((r) => ({ ...r, id: String(r.id) })));
  });

  return router;
};
