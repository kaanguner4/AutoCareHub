'use strict';
const express = require('express');
const { withTransaction } = require('../db');
const { requireAuth, requireCustomer } = require('../auth');
const { badRequest, notFound, conflict, text, id } = require('../http');

const TZ = 'Europe/Istanbul';
const MAX_DAYS_AHEAD = 90;
const MAX_SERVICES = 10;
// Opening hours of the workshops: Monday-Friday 08:30-17:30, Saturday 08:30-13:30, Sunday closed.
const SLOTS_WEEKDAY = halfHours('08:30', '17:30');
const SLOTS_SATURDAY = halfHours('08:30', '13:30');

// new status -> statuses it may come from
const STAFF_TRANSITIONS = {
  confirmed: ['pending'],
  cancelled: ['pending', 'confirmed'],
  completed: ['confirmed'],
  no_show: ['confirmed'],
};
const CUSTOMER_TRANSITIONS = { cancelled: ['pending', 'confirmed'] };

function halfHours(from, to) {
  const out = [];
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  for (let m = fh * 60 + fm; m <= th * 60 + tm; m += 30) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
}

function istanbulNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const dayNumber = (isoDate) => Date.UTC(...isoDate.split('-').map((v, i) => Number(v) - (i === 1 ? 1 : 0))) / 86_400_000;

// WHERE fragment limiting appointments to what the signed-in user may see.
function scope(user, params) {
  if (user.role === 'customer') {
    params.push(user.customerId);
    return `a.customer_id = $${params.length}`;
  }
  if (user.scope === 'branch') {
    params.push(user.branchId);
    return `a.branch_id = $${params.length}`;
  }
  return 'TRUE'; // HQ admin
}

const SELECT = `
  SELECT a.id, a.status, a.channel, a.requested_at, a.scheduled_for, a.note,
         a.branch_id, b.name AS branch_name,
         a.vehicle_id, v.brand, v.model, v.plate,
         a.customer_id, c.full_name_or_company AS customer_name,
         coalesce(req.names, wo.names) AS services,
         coalesce(inv.total_try, req.price) AS amount_try,
         (inv.total_try IS NOT NULL) AS amount_is_invoice
  FROM appointments a
  JOIN branches b  ON b.id = a.branch_id
  JOIN vehicles v  ON v.id = a.vehicle_id
  JOIN customers c ON c.id = a.customer_id
  LEFT JOIN LATERAL (
    SELECT string_agg(sc.name, ', ' ORDER BY sc.name) AS names, sum(x.list_price_try) AS price
    FROM appointment_services x JOIN service_catalog sc ON sc.id = x.service_id
    WHERE x.appointment_id = a.id) req ON true
  LEFT JOIN LATERAL (
    SELECT string_agg(DISTINCT sc.name, ', ') AS names
    FROM work_orders w
    JOIN work_order_items i ON i.work_order_id = w.id AND i.item_type = 'labor'
    JOIN service_catalog sc ON sc.id = i.service_id
    WHERE w.appointment_id = a.id) wo ON true
  LEFT JOIN LATERAL (
    SELECT inv.total_try FROM work_orders w JOIN invoices inv ON inv.work_order_id = w.id
    WHERE w.appointment_id = a.id AND inv.status <> 'void' LIMIT 1) inv ON true`;

function shape(r) {
  return {
    id: String(r.id), status: r.status, channel: r.channel,
    requested_at: r.requested_at, scheduled_for: r.scheduled_for, note: r.note,
    branch: { id: String(r.branch_id), name: r.branch_name },
    vehicle: { id: String(r.vehicle_id), brand: r.brand, model: r.model, plate: r.plate },
    customer: { id: String(r.customer_id), name: r.customer_name },
    services: r.services, amount_try: r.amount_try === null ? null : Number(r.amount_try),
    amount_is_invoice: r.amount_is_invoice,
  };
}

module.exports = function appointmentRoutes(pool) {
  const router = express.Router();

  // Customers: own appointments. Branch admins: their branch. HQ admin: all branches.
  // ?view=active (pending/confirmed, soonest first) | history (finished, newest first) | all (newest first)
  router.get('/appointments', requireAuth, async (req, res) => {
    const view = ['active', 'history', 'all'].includes(req.query.view) ? req.query.view : 'all';
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
    const params = [];
    const where = [scope(req.user, params)];
    if (view === 'active') where.push("a.status IN ('pending', 'confirmed')");
    if (view === 'history') where.push("a.status IN ('completed', 'cancelled', 'no_show')");
    params.push(limit);
    const order = view === 'active' ? 'a.scheduled_for ASC, a.id ASC' : 'a.scheduled_for DESC, a.id DESC';
    const { rows } = await pool.query(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${params.length}`, params);
    res.json(rows.map(shape));
  });

  router.get('/appointments/:id', requireAuth, async (req, res) => {
    const aid = id(req.params.id);
    if (!aid) throw notFound();
    const params = [aid];
    const { rows } = await pool.query(`${SELECT} WHERE a.id = $1 AND ${scope(req.user, params)}`, params);
    if (!rows[0]) throw notFound();
    res.json(shape(rows[0]));
  });

  // A web booking only creates a pending appointment; staff confirm it.
  router.post('/appointments', requireCustomer, async (req, res) => {
    const b = req.body ?? {};
    const vehicleId = id(b.vehicle_id);
    const branchId = id(b.branch_id);
    const date = typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null;
    const time = typeof b.time === 'string' ? b.time : '';
    const note = text(b.note, { max: 500 });
    const serviceIds = Array.isArray(b.service_ids) ? [...new Set(b.service_ids.map(id))] : [];

    if (!vehicleId) throw badRequest('Please choose one of your vehicles.');
    if (!branchId) throw badRequest('Please choose a branch.');
    if (!date || Number.isNaN(dayNumber(date)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
      throw badRequest('Please choose a valid date.');
    }
    const now = istanbulNow();
    const daysAhead = dayNumber(date) - dayNumber(now.date);
    if (daysAhead < 0 || daysAhead > MAX_DAYS_AHEAD) {
      throw badRequest(`Please choose a date within the next ${MAX_DAYS_AHEAD} days.`);
    }
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 0) throw badRequest('Our branches are closed on Sundays.');
    const slots = weekday === 6 ? SLOTS_SATURDAY : SLOTS_WEEKDAY;
    if (!slots.includes(time)) throw badRequest('Please choose a time between the opening hours.');
    if (daysAhead === 0 && time <= now.time) throw badRequest('Please choose a time later today or another day.');
    if (note === null) throw badRequest('The note can be at most 500 characters.');
    if (serviceIds.length === 0 || serviceIds.length > MAX_SERVICES || serviceIds.includes(null)) {
      throw badRequest(`Please choose 1 to ${MAX_SERVICES} services.`);
    }

    const appointmentId = await withTransaction(pool, async (client) => {
      const own = await client.query('SELECT 1 FROM vehicles WHERE id = $1 AND customer_id = $2',
        [vehicleId, req.user.customerId]);
      if (own.rowCount === 0) throw badRequest('Please choose one of your vehicles.');
      const branch = await client.query(
        `SELECT 1 FROM branches WHERE id = $1 AND opened_on <= $2::date
           AND (closed_on IS NULL OR closed_on > $2::date)`, [branchId, date]);
      if (branch.rowCount === 0) throw badRequest('Please choose a branch.');
      const { rows } = await client.query(
        `INSERT INTO appointments (customer_id, vehicle_id, branch_id, requested_at, scheduled_for, channel, status, note)
         VALUES ($1, $2, $3, now(), ($4::date + $5::time) AT TIME ZONE '${TZ}', 'web', 'pending', $6)
         RETURNING id`,
        [req.user.customerId, vehicleId, branchId, date, time, note || null]);
      const added = await client.query(
        `INSERT INTO appointment_services (appointment_id, service_id, list_price_try)
         SELECT $1, s.id, p.list_price_try
         FROM service_catalog s
         JOIN service_prices p ON p.service_id = s.id AND p.valid_from <= current_date
                              AND (p.valid_to IS NULL OR p.valid_to >= current_date)
         WHERE s.active AND s.id = ANY($2::bigint[])`,
        [rows[0].id, serviceIds]);
      if (added.rowCount !== serviceIds.length) throw badRequest('One of the chosen services is not available.');
      return String(rows[0].id);
    });
    res.status(201).json({ id: appointmentId, status: 'pending' });
  });

  // Customers may cancel their own upcoming appointments; staff move appointments of their scope along.
  router.put('/appointments/:id/status', requireAuth, async (req, res) => {
    const aid = id(req.params.id);
    if (!aid) throw notFound();
    const isCustomer = req.user.role === 'customer';
    const transitions = isCustomer ? CUSTOMER_TRANSITIONS : STAFF_TRANSITIONS;
    const status = req.body?.status;
    if (typeof status !== 'string' || !Object.hasOwn(transitions, status)) {
      throw badRequest('This status change is not allowed.');
    }
    const params = [aid, status, transitions[status]];
    const where = [`a.id = $1`, scope(req.user, params), 'a.status = ANY($3::text[])'];
    if (isCustomer) where.push('a.scheduled_for > now()');
    const { rowCount } = await pool.query(
      `UPDATE appointments a SET status = $2 WHERE ${where.join(' AND ')}`, params);
    if (rowCount === 0) {
      const check = [aid];
      const { rows } = await pool.query(`SELECT 1 FROM appointments a WHERE a.id = $1 AND ${scope(req.user, check)}`, check);
      if (!rows[0]) throw notFound();
      throw conflict(isCustomer ? 'This appointment can no longer be cancelled.' : 'This status change is not allowed.');
    }
    res.json({ id: aid, status });
  });

  return router;
};
