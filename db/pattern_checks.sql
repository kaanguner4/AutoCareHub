-- Pattern checks for the synthetic AutoCare Türkiye data: one query per demo pattern of the ACH brief.
-- Read-only; run as sqlbuddy_ro, e.g.
--   docker compose exec -T -e PGPASSWORD=... db psql -h localhost -U sqlbuddy_ro -d autocare < db/pattern_checks.sql
\pset footer off

\echo '== 1. Seasonality: labour lines per calendar month, full years 2023-2025 (tyres Apr+Nov, AC May-Jun, battery Dec-Jan)'
SELECT EXTRACT(MONTH FROM wo.opened_at)::int AS month,
       count(*) FILTER (WHERE sc.category = 'tyres')                                        AS tyres,
       count(*) FILTER (WHERE sc.category = 'ac')                                           AS ac,
       count(*) FILTER (WHERE sc.category = 'ac' AND b.city IN ('Antalya', 'Adana'))        AS ac_antalya_adana,
       count(*) FILTER (WHERE sc.name ILIKE 'akü%')                                         AS battery
FROM work_order_items i
JOIN work_orders wo     ON wo.id = i.work_order_id
JOIN branches b         ON b.id = wo.branch_id
JOIN service_catalog sc ON sc.id = i.service_id
WHERE i.item_type = 'labor' AND wo.status <> 'cancelled'
  AND wo.opened_at >= '2023-01-01' AND wo.opened_at < '2026-01-01'
GROUP BY 1 ORDER BY 1;

\echo '== 1b. AC share of all jobs in May-June by city (strongest in Antalya and Adana)'
SELECT b.city,
       round(100.0 * count(*) FILTER (WHERE sc.category = 'ac') / count(*), 1) AS ac_share_may_jun_pct
FROM work_order_items i
JOIN work_orders wo     ON wo.id = i.work_order_id
JOIN branches b         ON b.id = wo.branch_id
JOIN service_catalog sc ON sc.id = i.service_id
WHERE i.item_type = 'labor' AND EXTRACT(MONTH FROM wo.opened_at) IN (5, 6)
GROUP BY b.city ORDER BY 2 DESC;

\echo '== 2. Price rise: average January list-price increase per year (per service)'
SELECT EXTRACT(YEAR FROM cur.valid_from)::int                       AS year,
       count(*)                                                     AS services,
       round(avg(100 * (cur.list_price_try / prev.list_price_try - 1)), 1) AS avg_increase_pct,
       round(min(100 * (cur.list_price_try / prev.list_price_try - 1)), 1) AS min_pct,
       round(max(100 * (cur.list_price_try / prev.list_price_try - 1)), 1) AS max_pct
FROM service_prices cur
JOIN service_prices prev ON prev.service_id = cur.service_id
                        AND prev.valid_from = cur.valid_from - interval '1 year'
GROUP BY 1 ORDER BY 1;

\echo '== 3. Çankaya: rating and wait for a slot per quarter vs. all other branches'
SELECT q.quarter,
       q.cankaya_rating, q.others_rating, w.cankaya_wait_days, w.others_wait_days
FROM (SELECT date_trunc('quarter', r.created_at)::date AS quarter,
             round(avg(r.rating) FILTER (WHERE b.code = 'ANK-CAN'), 2)  AS cankaya_rating,
             round(avg(r.rating) FILTER (WHERE b.code <> 'ANK-CAN'), 2) AS others_rating
      FROM reviews r JOIN branches b ON b.id = r.branch_id
      WHERE r.created_at >= '2025-01-01'
      GROUP BY 1) q
JOIN (SELECT date_trunc('quarter', a.scheduled_for)::date AS quarter,
             round(avg(EXTRACT(EPOCH FROM a.scheduled_for - a.requested_at) / 86400)
                   FILTER (WHERE b.code = 'ANK-CAN'), 1)  AS cankaya_wait_days,
             round(avg(EXTRACT(EPOCH FROM a.scheduled_for - a.requested_at) / 86400)
                   FILTER (WHERE b.code <> 'ANK-CAN'), 1) AS others_wait_days
      FROM appointments a JOIN branches b ON b.id = a.branch_id
      WHERE a.channel <> 'walk_in' AND a.scheduled_for >= '2025-01-01' AND a.scheduled_for <= '2026-11-15'
      GROUP BY 1) w USING (quarter)
ORDER BY 1;

\echo '== 4. Labour revenue per technician, last 12 months (Bornova best)'
SELECT b.name,
       count(DISTINCT i.technician_employee_id) AS technicians,
       round(sum(i.quantity * i.unit_price_try * (1 - i.discount_pct / 100))) AS labor_revenue_try,
       round(sum(i.quantity * i.unit_price_try * (1 - i.discount_pct / 100))
             / count(DISTINCT i.technician_employee_id)) AS revenue_per_technician_try
FROM work_order_items i
JOIN work_orders wo ON wo.id = i.work_order_id
JOIN branches b     ON b.id = wo.branch_id
WHERE i.item_type = 'labor' AND wo.status = 'done'
  AND wo.closed_at >= timestamptz '2026-11-15 18:00+03' - interval '12 months'
GROUP BY b.name ORDER BY revenue_per_technician_try DESC;

\echo '== 5. Fleet customers with overdue invoices'
SELECT c.full_name_or_company,
       count(*)                                   AS overdue_invoices,
       sum(inv.total_try - coalesce(p.paid, 0))   AS outstanding_try,
       min(inv.due_on)                            AS oldest_due_on
FROM invoices inv
JOIN customers c ON c.id = inv.customer_id
LEFT JOIN (SELECT invoice_id, sum(amount_try) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = inv.id
WHERE inv.status = 'overdue'
GROUP BY c.id, c.full_name_or_company, c.type ORDER BY outstanding_try DESC;

\echo '== 6. Stock below reorder point (branch x part pairs)'
SELECT count(*)                       AS pairs_below_reorder_point,
       count(DISTINCT s.part_id)      AS parts,
       count(DISTINCT s.branch_id)    AS branches,
       count(*) FILTER (WHERE s.on_hand = 0) AS out_of_stock
FROM stock_levels s JOIN parts p ON p.id = s.part_id
WHERE s.on_hand < p.reorder_point;

\echo '== 7. Winter tyre campaign uplift: tyre jobs per working day in November, campaign days vs. other days'
WITH daily AS (
    SELECT wo.opened_at::date AS day, count(*) AS tyre_jobs
    FROM work_order_items i
    JOIN work_orders wo     ON wo.id = i.work_order_id
    JOIN service_catalog sc ON sc.id = i.service_id
    WHERE i.item_type = 'labor' AND sc.category = 'tyres' AND EXTRACT(MONTH FROM wo.opened_at) = 11
      AND wo.opened_at < '2026-01-01'
    GROUP BY 1
)
SELECT EXTRACT(YEAR FROM d.day)::int AS year,
       round(avg(d.tyre_jobs) FILTER (WHERE c.id IS NOT NULL), 1) AS per_day_in_campaign,
       round(avg(d.tyre_jobs) FILTER (WHERE c.id IS NULL), 1)     AS per_day_outside,
       round(100 * (avg(d.tyre_jobs) FILTER (WHERE c.id IS NOT NULL)
                    / avg(d.tyre_jobs) FILTER (WHERE c.id IS NULL) - 1), 1) AS uplift_pct
FROM daily d
LEFT JOIN campaigns c ON c.service_category = 'tyres' AND d.day BETWEEN c.starts_on AND c.ends_on
GROUP BY 1 ORDER BY 1;

\echo '== 8. Growth: work orders per year (Jan-Oct for a like-for-like comparison)'
SELECT year, work_orders, jan_oct,
       round(100 * (jan_oct::numeric / lag(jan_oct) OVER (ORDER BY year) - 1), 1) AS jan_oct_yoy_pct
FROM (SELECT EXTRACT(YEAR FROM opened_at)::int AS year,
             count(*) AS work_orders,
             count(*) FILTER (WHERE EXTRACT(MONTH FROM opened_at) <= 10) AS jan_oct
      FROM work_orders
      GROUP BY 1) y
ORDER BY year;
