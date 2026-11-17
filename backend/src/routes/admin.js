'use strict';
const express = require('express');
const { requireAdmin, branchScope } = require('../auth');

// Staff views. Branch admins see their own branch; the HQ admin (no branch) sees all branches.
module.exports = function adminRoutes(pool) {
  const router = express.Router();
  router.use('/admin', requireAdmin);

  router.get('/admin/stats', async (req, res) => {
    const branch = branchScope(req.user);
    const { rows: [a] } = await pool.query(`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE status = 'pending')   AS pending,
             count(*) FILTER (WHERE status = 'completed') AS completed
      FROM appointments WHERE ($1::bigint IS NULL OR branch_id = $1)`, [branch]);
    const { rows: [r] } = await pool.query(`
      SELECT coalesce(sum(total_try), 0) AS revenue
      FROM invoices
      WHERE status <> 'void' AND issued_at >= now() - interval '30 days'
        AND ($1::bigint IS NULL OR branch_id = $1)`, [branch]);
    res.json({
      scope: req.user.scope,
      branch: req.user.branchId ? { id: req.user.branchId, name: req.user.branchName } : null,
      appointments_total: Number(a.total),
      appointments_pending: Number(a.pending),
      appointments_completed: Number(a.completed),
      revenue_30d_try: Number(r.revenue),
    });
  });

  // Web logins: branch admins see the staff of their branch and the customers who booked there.
  router.get('/admin/users', async (req, res) => {
    const branch = branchScope(req.user);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
    const { rows } = await pool.query(`
      SELECT u.id, u.email, u.role, u.created_at, (u.password_hash IS NOT NULL) AS can_sign_in,
             coalesce(c.full_name_or_company, e.full_name, 'Head office') AS name,
             b.id AS branch_id, b.name AS branch_name
      FROM app_users u
      LEFT JOIN customers c ON c.id = u.customer_id
      LEFT JOIN employees e ON e.id = u.employee_id
      LEFT JOIN branches b  ON b.id = e.branch_id
      WHERE $1::bigint IS NULL
         OR e.branch_id = $1
         OR EXISTS (SELECT 1 FROM appointments a WHERE a.customer_id = u.customer_id AND a.branch_id = $1)
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT $2`, [branch, limit]);
    res.json(rows.map((r) => ({
      id: String(r.id), email: r.email, role: r.role, name: r.name, created_at: r.created_at,
      can_sign_in: r.can_sign_in, branch: r.branch_id ? { id: String(r.branch_id), name: r.branch_name } : null,
    })));
  });

  return router;
};
