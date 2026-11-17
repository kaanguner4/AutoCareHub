'use strict';
// API tests against the running database (run inside the compose network):
//   docker compose --profile test run --rm test
// Uses the six demo logins (password SEED_DEMO_PASSWORD) and cleans up everything it creates.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const config = require('../src/config').load();
const { createPool } = require('../src/db');
const { createApp } = require('../src/app');

const ORIGIN = config.appOrigin;
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD;
const RUN = `${Date.now()}`;
const TEST_EMAIL_LIKE = 'ach2-test-%@example.com';
const SQL_LEAK = /select |insert |update |delete |relation|syntax|column|constraint|violates|pg_|stack|at .*\.js/i;

let pool;
let app;
const demo = {};               // customerA, customerB, fleet, adminKadikoy, adminCankaya, hq
const createdAppointments = [];
const errorBodies = [];        // every non-2xx body seen, checked for leaks at the end

function track(res) {
  if (res.status >= 400) errorBodies.push(JSON.stringify(res.body ?? res.text));
  return res;
}
// Agent with the cookie jar; every state-changing call carries the app's Origin.
function client(theApp = app) {
  const agent = request.agent(theApp);
  return {
    get: async (url) => track(await agent.get(url)),
    post: async (url, body, origin = ORIGIN) => track(await withOrigin(agent.post(url), origin).send(body ?? {})),
    put: async (url, body, origin = ORIGIN) => track(await withOrigin(agent.put(url), origin).send(body ?? {})),
    del: async (url, origin = ORIGIN) => track(await withOrigin(agent.delete(url), origin)),
  };
}
const withOrigin = (req, origin) => (origin ? req.set('Origin', origin) : req);

async function signIn(email, password = DEMO_PASSWORD) {
  const c = client();
  const res = await c.post('/api/login', { email, password });
  assert.equal(res.status, 200, `login ${email}`);
  return c;
}

function nextWeekday(daysAhead = 3) {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

before(async () => {
  assert.ok(DEMO_PASSWORD, 'SEED_DEMO_PASSWORD must be set');
  pool = createPool(config.db);
  app = createApp(config, pool);
  const { rows } = await pool.query(`
    SELECT u.email, u.role, c.type, e.branch_id, b.code
    FROM app_users u
    LEFT JOIN customers c ON c.id = u.customer_id
    LEFT JOIN employees e ON e.id = u.employee_id
    LEFT JOIN branches b ON b.id = e.branch_id
    WHERE u.password_hash IS NOT NULL AND u.email NOT LIKE $1 ORDER BY u.id`, [TEST_EMAIL_LIKE]);
  const individuals = rows.filter((r) => r.role === 'customer' && r.type === 'individual');
  demo.customerA = individuals[0].email;
  demo.customerB = individuals[1].email;
  demo.fleet = rows.find((r) => r.type === 'fleet').email;
  demo.adminKadikoy = rows.find((r) => r.code === 'IST-KAD').email;
  demo.adminCankaya = rows.find((r) => r.code === 'ANK-CAN').email;
  demo.hq = rows.find((r) => r.role === 'admin' && !r.branch_id).email;
  assert.equal(rows.length, 6, 'exactly six demo logins can sign in');
});

after(async () => {
  if (createdAppointments.length) {
    await pool.query('DELETE FROM appointments WHERE id = ANY($1::bigint[])', [createdAppointments]);
  }
  const customers = `SELECT customer_id FROM app_users WHERE email LIKE $1`;
  await pool.query(`DELETE FROM appointments WHERE customer_id IN (${customers})`, [TEST_EMAIL_LIKE]);
  await pool.query(`DELETE FROM vehicles WHERE customer_id IN (${customers})`, [TEST_EMAIL_LIKE]);
  const { rows } = await pool.query('DELETE FROM app_users WHERE email LIKE $1 RETURNING customer_id', [TEST_EMAIL_LIKE]);
  await pool.query('DELETE FROM customers WHERE id = ANY($1::bigint[])', [rows.map((r) => r.customer_id)]);
  await pool.end();
});

test('health answers ok without details', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});

test('register, sign in, me, sign out; cookie is httpOnly + SameSite=Lax', async () => {
  const c = client();
  const email = `ach2-test-${RUN}@example.com`;
  const reg = await c.post('/api/register', { name: 'Test Kullanıcı', email, phone: '+90 555 000 00 00', city: 'İzmir', password: 'correct horse 42' });
  assert.equal(reg.status, 201);
  assert.equal((await c.post('/api/register', { name: 'Test', email, phone: '+90 555 000 00 01', city: 'İzmir', password: 'another pass 42' })).status, 409);
  assert.equal((await c.post('/api/register', { name: 'Test', email: `x${email}`, phone: '+90 555 000 00 02', city: 'İzmir', password: 'short' })).status, 400);

  assert.equal((await c.post('/api/login', { email, password: 'wrong password' })).status, 401);
  const login = await c.post('/api/login', { email, password: 'correct horse 42' });
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'].join(';');
  assert.match(cookie, /autocare_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.doesNotMatch(cookie, /Secure/i, 'no Secure flag on an http origin');

  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'customer');
  assert.equal(me.body.user.scope, 'customer');
  assert.equal(me.body.user.email, email);

  const veh = await c.post('/api/vehicles', { brand: 'Fiat', model: 'Egea', plate: `35 zz ${RUN.slice(-3)}`, model_year: 2022, fuel: 'lpg' });
  assert.equal(veh.status, 201);
  assert.equal(veh.body.plate, `35 ZZ ${RUN.slice(-3)}`);
  assert.equal((await c.del(`/api/vehicles/${veh.body.id}`)).status, 200);

  assert.equal((await c.post('/api/logout')).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
});

test('Secure cookie flag when APP_ORIGIN is https', async () => {
  const httpsApp = createApp({ ...config, appOrigin: 'https://autocare.example', secure: true }, pool);
  const res = await request(httpsApp).post('/api/login').set('Origin', 'https://autocare.example')
    .send({ email: demo.customerA, password: DEMO_PASSWORD });
  assert.equal(res.status, 200);
  assert.match(res.headers['set-cookie'].join(';'), /Secure/);
  assert.match(res.headers['strict-transport-security'] ?? '', /max-age/);
});

test('seeded logins without a demo password cannot sign in', async () => {
  const { rows } = await pool.query("SELECT email FROM app_users WHERE password_hash IS NULL AND role = 'customer' LIMIT 1");
  const res = await client().post('/api/login', { email: rows[0].email, password: DEMO_PASSWORD });
  assert.equal(res.status, 401);
});

test('a customer cannot read or change another customer\'s vehicle or appointment', async () => {
  const a = await signIn(demo.customerA);
  const b = await signIn(demo.customerB);
  const meA = (await a.get('/api/me')).body.user;
  const bVehicles = (await b.get('/api/vehicles')).body;
  const bAppointments = (await b.get('/api/appointments?view=all&limit=5')).body;
  assert.ok(bVehicles.length > 0 && bAppointments.length > 0);
  const bVehicle = bVehicles[0].id;
  const bAppointment = bAppointments[0].id;

  assert.equal((await a.get(`/api/vehicles/${bVehicle}`)).status, 404);
  assert.equal((await a.del(`/api/vehicles/${bVehicle}`)).status, 404);
  assert.equal((await a.get(`/api/appointments/${bAppointment}`)).status, 404);
  assert.equal((await a.put(`/api/appointments/${bAppointment}/status`, { status: 'cancelled' })).status, 404);
  const book = await a.post('/api/appointments', { vehicle_id: bVehicle, branch_id: '1', date: nextWeekday(), time: '10:00', service_ids: ['1'] });
  assert.equal(book.status, 400);

  const own = (await a.get('/api/appointments?view=all&limit=200')).body;
  assert.ok(own.length > 0);
  const aVehicles = new Set((await a.get('/api/vehicles')).body.map((v) => v.id));
  assert.ok(own.every((x) => aVehicles.has(x.vehicle.id) || x.customer.name === meA.name));
  assert.equal(new Set(own.map((x) => x.customer.id)).size, 1, 'only one customer in the list');
  assert.equal((await a.get('/api/admin/stats')).status, 403);
  assert.equal((await client().get('/api/vehicles')).status, 401);
});

test('booking: customer creates a pending web appointment; only the right branch admin can move it', async () => {
  const a = await signIn(demo.customerA);
  const kad = await signIn(demo.adminKadikoy);
  const can = await signIn(demo.adminCankaya);
  const kadBranch = (await kad.get('/api/me')).body.user.branch.id;
  const vehicle = (await a.get('/api/vehicles')).body[0].id;
  const services = (await a.get('/api/services')).body;
  assert.equal(services.length, 58, 'active services with a current price');

  const book = await a.post('/api/appointments', {
    vehicle_id: vehicle, branch_id: kadBranch, date: nextWeekday(), time: '10:00',
    service_ids: [services[0].id, services[1].id], note: '<script>alert(1)</script> fren sesi',
  });
  assert.equal(book.status, 201);
  createdAppointments.push(book.body.id);
  const mine = (await a.get(`/api/appointments/${book.body.id}`)).body;
  assert.equal(mine.status, 'pending');
  assert.equal(mine.channel, 'web');
  assert.equal(mine.amount_try, services[0].list_price_try + services[1].list_price_try);

  assert.equal((await can.put(`/api/appointments/${book.body.id}/status`, { status: 'confirmed' })).status, 404);
  assert.equal((await kad.put(`/api/appointments/${book.body.id}/status`, { status: 'completed' })).status, 409);
  assert.equal((await kad.put(`/api/appointments/${book.body.id}/status`, { status: 'confirmed' })).status, 200);
  assert.equal((await a.put(`/api/appointments/${book.body.id}/status`, { status: 'confirmed' })).status, 400);
  assert.equal((await a.put(`/api/appointments/${book.body.id}/status`, { status: 'cancelled' })).status, 200);

  const sunday = new Date();
  sunday.setUTCDate(sunday.getUTCDate() + ((7 - sunday.getUTCDay()) % 7 || 7));
  const closed = await a.post('/api/appointments', { vehicle_id: vehicle, branch_id: kadBranch, date: sunday.toISOString().slice(0, 10), time: '10:00', service_ids: [services[0].id] });
  assert.equal(closed.status, 400);
});

test('out-of-scope status changes are 404 whatever the requested status (no existence leak)', async () => {
  const can = await signIn(demo.adminCankaya);
  const a = await signIn(demo.customerA);
  const me = (await can.get('/api/me')).body.user;
  const { rows: [other] } = await pool.query(
    "SELECT id FROM appointments WHERE branch_id <> $1 AND status = 'completed' ORDER BY id LIMIT 1", [me.branch.id]);
  const { rows: [missing] } = await pool.query('SELECT max(id) + 1000 AS id FROM appointments');
  for (const status of ['confirmed', 'completed', 'not-a-status', '', null, 42]) {
    const foreign = await can.put(`/api/appointments/${other.id}/status`, { status });
    const absent = await can.put(`/api/appointments/${missing.id}/status`, { status });
    assert.equal(foreign.status, 404, `branch admin, foreign appointment, status ${JSON.stringify(status)}`);
    assert.deepEqual(foreign.body, absent.body, 'foreign and non-existent ids answer identically');
  }
  const bAppt = (await (await signIn(demo.customerB)).get('/api/appointments?view=all&limit=1')).body[0].id;
  for (const status of ['confirmed', 'completed', 'cancelled', 'bogus']) {
    assert.equal((await a.put(`/api/appointments/${bAppt}/status`, { status })).status, 404, `customer, foreign, ${status}`);
  }
  // In scope, the order is: unknown status -> 400, wrong transition -> 409.
  const { rows: [own] } = await pool.query(
    "SELECT id FROM appointments WHERE branch_id = $1 AND status = 'completed' ORDER BY id LIMIT 1", [me.branch.id]);
  assert.equal((await can.put(`/api/appointments/${own.id}/status`, { status: 'bogus' })).status, 400);
  assert.equal((await can.put(`/api/appointments/${own.id}/status`, { status: 'confirmed' })).status, 409);
});

test('branch admin sees only the own branch', async () => {
  const kad = await signIn(demo.adminKadikoy);
  const me = (await kad.get('/api/me')).body.user;
  assert.equal(me.scope, 'branch');
  for (const view of ['active', 'history']) {
    const list = (await kad.get(`/api/appointments?view=${view}&limit=500`)).body;
    assert.ok(list.length > 0, view);
    assert.ok(list.every((x) => x.branch.id === me.branch.id), `${view}: only own branch`);
  }
  const { rows } = await pool.query('SELECT id FROM appointments WHERE branch_id <> $1 ORDER BY id LIMIT 1', [me.branch.id]);
  assert.equal((await kad.get(`/api/appointments/${rows[0].id}`)).status, 404);
  assert.equal((await kad.put(`/api/appointments/${rows[0].id}/status`, { status: 'cancelled' })).status, 404);

  const stats = (await kad.get('/api/admin/stats')).body;
  assert.equal(stats.scope, 'branch');
  const { rows: [count] } = await pool.query('SELECT count(*)::int AS n FROM appointments WHERE branch_id = $1', [me.branch.id]);
  assert.equal(stats.appointments_total, count.n);

  const users = (await kad.get('/api/admin/users?limit=500')).body;
  assert.ok(users.length > 0);
  assert.ok(users.every((u) => u.branch === null || u.branch.id === me.branch.id));
  assert.ok(users.every((u) => !('password_hash' in u)));
});

test('HQ admin sees all branches', async () => {
  const hq = await signIn(demo.hq);
  const me = (await hq.get('/api/me')).body.user;
  assert.equal(me.scope, 'hq');
  assert.equal(me.branch, null);
  const list = (await hq.get('/api/appointments?view=history&limit=500')).body;
  assert.ok(new Set(list.map((x) => x.branch.id)).size > 1);
  const stats = (await hq.get('/api/admin/stats')).body;
  const { rows: [count] } = await pool.query('SELECT count(*)::int AS n FROM appointments');
  assert.equal(stats.appointments_total, count.n);
  const users = (await hq.get('/api/admin/users?limit=500')).body;
  const { rows: newest } = await pool.query('SELECT id::text FROM app_users ORDER BY created_at DESC, id DESC LIMIT 500');
  assert.deepEqual(users.map((u) => u.id), newest.map((r) => r.id), 'HQ sees every login, unfiltered');
});

test('state-changing requests need the app Origin (missing or foreign -> 403)', async () => {
  const anon = client();
  assert.equal((await anon.post('/api/login', { email: demo.customerA, password: DEMO_PASSWORD }, null)).status, 403);
  assert.equal((await anon.post('/api/login', { email: demo.customerA, password: DEMO_PASSWORD }, 'https://evil.example')).status, 403);
  const a = await signIn(demo.customerA);
  const appt = (await a.get('/api/appointments?view=all&limit=1')).body[0].id;
  assert.equal((await a.put(`/api/appointments/${appt}/status`, { status: 'cancelled' }, 'https://evil.example')).status, 403);
  assert.equal((await a.del('/api/vehicles/1', null)).status, 403);
  assert.equal((await a.post('/api/logout', {}, 'http://localhost:3000.evil.example')).status, 403);
  assert.equal((await a.get('/api/me')).status, 200, 'GET needs no Origin');
});

test('login rate limit answers 429', async () => {
  const limited = createApp(config, pool, { loginLimit: 3 });
  const c = client(limited);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await c.post('/api/login', { email: `nobody${i}@example.com`, password: 'wrong password' })).status, 401);
  }
  assert.equal((await c.post('/api/login', { email: 'nobody@example.com', password: 'wrong password' })).status, 429);
});

test('only the page files are served; security headers are set', async () => {
  const page = await request(app).get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /html/);
  const csp = page.headers['content-security-policy'];
  for (const d of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "font-src 'self'",
    "img-src 'self' data:", "connect-src 'self'", "script-src-attr 'none'", "frame-ancestors 'none'"]) {
    assert.ok(csp.split(';').map((x) => x.trim()).includes(d), `CSP has ${d}`);
  }
  assert.doesNotMatch(csp, /https?:|unsafe-inline|unsafe-eval/, 'no external hosts or unsafe keywords in the CSP');
  assert.equal(page.headers['x-powered-by'], undefined);
  for (const path of ['/.env', '/backend/src/config.js', '/seed/out/manifest.tsv', '/../.env', '/docker-compose.yml',
    '/vendor/poppins/package.json', '/vendor/bootstrap/../package.json', '/vendor/poppins/README.md']) {
    assert.equal((await request(app).get(path)).status, 404, path);
  }
  assert.equal((await request(app).get('/main.js')).status, 200);
  for (const [path, type] of [
    ['/vendor/bootstrap/css/bootstrap.min.css', /css/], ['/vendor/bootstrap/js/bootstrap.bundle.min.js', /javascript/],
    ['/vendor/fontawesome/css/all.min.css', /css/], ['/vendor/fontawesome/webfonts/fa-solid-900.woff2', /font|octet/],
    ['/vendor/poppins/400.css', /css/], ['/vendor/poppins/files/poppins-latin-ext-600-normal.woff2', /font|octet/],
    ['/hero.svg', /svg/], ['/admin.css', /css/]]) {
    const res = await request(app).get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers['content-type'], type, path);
  }
  // Pages and the stylesheet reference nothing outside the own origin (and no inline style/script attributes).
  for (const name of ['index.html', 'register.html', 'dashboard.html', 'appointment.html', 'admin.html', 'style.css', 'main.js', 'admin.js']) {
    const body = (await request(app).get(`/${name}`)).text;
    assert.doesNotMatch(body, /(src|href)="https?:|url\(['"]?https?:|@import url\(['"]?https?:/, `${name}: no external assets`);
    assert.doesNotMatch(body, /\sstyle="|<style|\son[a-z]+="/, `${name}: no inline style/handlers`);
  }
});

test('error bodies carry no SQL or internals', async () => {
  const failing = { query: async () => { throw new Error('relation "secret_table" does not exist at SELECT * FROM secret_table'); } };
  const broken = createApp(config, failing);
  const res = await request(broken).get('/api/services');
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Something went wrong. Please try again.' });
  const health = await request(broken).get('/health');
  assert.equal(health.status, 503);
  assert.deepEqual(health.body, { status: 'unavailable' });
  const bad = await request(app).post('/api/login').set('Origin', ORIGIN).set('Content-Type', 'application/json').send('{"email": ');
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: 'Invalid request.' });

  errorBodies.push(JSON.stringify(res.body), JSON.stringify(bad.body));
  assert.ok(errorBodies.length > 10, `collected ${errorBodies.length} error bodies`);
  for (const body of errorBodies) assert.doesNotMatch(body, SQL_LEAK, body);
});
