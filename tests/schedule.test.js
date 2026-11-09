// Scheduling: rules engine, proposals → calendar, conflicts, leave, reminders, job-lost cancellation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as D from '../shared/dates.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-sched-'));
process.env.DATA_DIR = dir;
const { openDatabase } = await import('../server/db/database.js');
const { createServer } = await import('../server/index.js');

let server, base, db, cookie = '';
async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'app', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

before(async () => {
  db = openDatabase(path.join(dir, 'test.db'));
  server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await call('POST', '/api/setup', { companyName: 'Sched Joinery', name: 'Owner', email: 'o@example.test', password: 'Testing-12345' });
  await call('POST', '/api/login', { email: 'o@example.test', password: 'Testing-12345' });
});
after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('date helpers: business days, overlaps, all-day spans', () => {
  assert.equal(D.weekday('2026-10-03'), 6); // Saturday
  assert.equal(D.nextBusinessDay('2026-10-03'), '2026-10-05');
  assert.equal(D.addBusinessDays('2026-10-08', 2), '2026-10-12'); // Thu + 2 business days = Mon
  assert.equal(D.addMinutes('2026-10-05T23:30', 60), '2026-10-06T00:30');
  assert.ok(D.overlaps({ allDay: true, start: '2026-10-05', end: '2026-10-06' }, { allDay: false, start: '2026-10-06T09:00', end: '2026-10-06T10:00' }));
  assert.ok(!D.overlaps({ allDay: false, start: '2026-10-06T08:00', end: '2026-10-06T09:00' }, { allDay: false, start: '2026-10-06T09:00', end: '2026-10-06T10:00' }));
});

test('setup creates placeholder staff and the eight workflow event types', async () => {
  const meta = (await call('GET', '/api/schedule/meta')).data;
  assert.equal(meta.staff.length, 10);
  assert.deepEqual(new Set(meta.staff.map((s) => s.category)), new Set(['designer', 'installer', 'project_manager', 'qa']));
  assert.deepEqual(meta.types.map((t) => t.key), ['consultation', 'site_inspection', 'check_measure', 'install', 'fit_off', 'walkthrough', 'feedback', 'six_month']);
});

let kitchenJob, robeJob;
test('rules decide which events each job needs', async () => {
  kitchenJob = (await call('POST', '/api/jobs', { name: 'Kitchen job', siteAddress: '1 Test St', areas: [
    { name: 'Kitchen', type: 'kitchen', defaultFinish: 'FG03', lines: [{ moduleKey: 'base-cabinet', qty: 12 }, { moduleKey: 'tall-cabinet', qty: 8 }, { moduleKey: 'drawer', qty: 6, optionKey: 'merivo-all-colours' }] },
  ] })).data.id;
  robeJob = (await call('POST', '/api/jobs', { name: 'Robe job', areas: [{ name: 'Robe', type: 'wardrobe', defaultFinish: 'FG01', lines: [{ moduleKey: 'tall-cabinet', qty: 2.4 }] }] })).data.id;

  const k = (await call('GET', `/api/jobs/${kitchenJob}/schedule`)).data;
  assert.equal(k.length, 8);
  assert.ok(k.every((e) => e.status === 'proposed'));
  const byKey = Object.fromEntries(k.map((e) => [e.typeKey, e]));
  assert.equal(byKey.site_inspection.included, true);
  assert.match(byKey.site_inspection.reason, /kitchen/);
  assert.equal(byKey.fit_off.included, true);
  assert.match(byKey.fit_off.reason, /Drawer/);
  assert.equal(byKey.install.allDay, true);
  assert.ok(D.daysBetween(byKey.install.start, byKey.install.end) >= 1, 'large kitchen installs over several days');
  assert.equal(byKey.install.staffIds.length, 2);
  assert.ok(D.dayNum(byKey.check_measure.start) > D.dayNum(byKey.site_inspection.start));
  assert.ok(D.dayNum(byKey.six_month.start) - D.dayNum(byKey.walkthrough.start) >= 180);
  for (const e of k) assert.ok(!D.isWeekend(D.dateOf(e.start)), `${e.title} starts on a weekday`);

  const r = Object.fromEntries((await call('GET', `/api/jobs/${robeJob}/schedule`)).data.map((e) => [e.typeKey, e]));
  assert.equal(r.site_inspection.included, false);
  assert.equal(r.fit_off.included, false);
  assert.equal(r.install.included, true);
});

test('two new jobs proposed at the same time get different staff suggested', async () => {
  const a = (await call('POST', '/api/jobs', { name: 'Same-day A', areas: [{ name: 'Kitchen', type: 'kitchen', lines: [] }] })).data.id;
  const b = (await call('POST', '/api/jobs', { name: 'Same-day B', areas: [{ name: 'Kitchen', type: 'kitchen', lines: [] }] })).data.id;
  const ca = (await call('GET', `/api/jobs/${a}/schedule`)).data.find((e) => e.typeKey === 'consultation');
  const cb = (await call('GET', `/api/jobs/${b}/schedule`)).data.find((e) => e.typeKey === 'consultation');
  assert.equal(ca.start, cb.start);
  assert.notDeepEqual(ca.staffIds, cb.staffIds);
  // only two designers exist, so a third job's consultation moves to the next day someone is free
  const c = (await call('POST', '/api/jobs', { name: 'Same-day C', areas: [{ name: 'Kitchen', type: 'kitchen', lines: [] }] })).data.id;
  const cc = (await call('GET', `/api/jobs/${c}/schedule`)).data.find((e) => e.typeKey === 'consultation');
  assert.ok(D.dayNum(cc.start) > D.dayNum(ca.start), 'third consultation is pushed later');
  assert.match(cc.reason, /Moved \d+ day/);
  assert.equal(cc.conflicts.length, 0);
  for (const j of [a, b, c]) await call('POST', `/api/jobs/${j}/archive`);
});

test('proposals stay off the calendar until confirmed', async () => {
  const from = D.today(), to = D.addDays(from, 400);
  assert.equal((await call('GET', `/api/events?from=${from}&to=${to}&job=${kitchenJob}`)).data.length, 0);
  const confirmed = (await call('POST', `/api/jobs/${kitchenJob}/schedule/confirm`)).data;
  assert.equal(confirmed.filter((e) => e.status === 'pending').length, 8);
  const cal = (await call('GET', `/api/events?from=${from}&to=${to}&job=${kitchenJob}`)).data;
  assert.equal(cal.length, 8);
  assert.equal(cal[0].jobNumber.startsWith('SCH-'), true);
});

test('drag-reschedule, reassign, double-booking and leave conflicts', async () => {
  const cal = (await call('GET', `/api/events?from=${D.today()}&to=${D.addDays(D.today(), 400)}&job=${kitchenJob}`)).data;
  const consult = cal.find((e) => e.typeKey === 'consultation');
  const measure = cal.find((e) => e.typeKey === 'check_measure');
  // move the check measure onto the consultation's slot and give it the same person
  const moved = await call('PUT', `/api/events/${measure.id}`, { start: consult.start, end: D.addMinutes(consult.start, 60), staffIds: consult.staffIds });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.start, consult.start);
  assert.equal(moved.data.conflicts.length, 1);
  assert.equal(moved.data.conflicts[0].kind, 'event');
  // leave for that person on that day also conflicts
  await call('POST', '/api/leave', { staffId: consult.staffIds[0], start: D.dateOf(consult.start), end: D.dateOf(consult.start), reason: 'Annual leave' });
  const again = (await call('GET', `/api/events?from=${D.dateOf(consult.start)}&to=${D.dateOf(consult.start)}&job=${kitchenJob}`)).data.find((e) => e.id === measure.id);
  assert.ok(again.conflicts.some((c) => c.kind === 'leave'));
  // filters: by staff and by type
  const byStaff = (await call('GET', `/api/events?from=${D.today()}&to=${D.addDays(D.today(), 400)}&staff=${consult.staffIds[0]}`)).data;
  assert.ok(byStaff.every((e) => e.staffIds.includes(consult.staffIds[0])));
  const byType = (await call('GET', `/api/events?from=${D.today()}&to=${D.addDays(D.today(), 400)}&types=install`)).data;
  assert.ok(byType.length >= 1 && byType.every((e) => e.typeKey === 'install'));
  // invalid times are rejected
  assert.equal((await call('PUT', `/api/events/${measure.id}`, { start: '2026-10-10T10:00', end: '2026-10-10T09:00' })).status, 400);
});

test('status tracking and reminders', async () => {
  const soon = D.addMinutes(D.nowLocal(), 120);
  const ev = (await call('POST', '/api/events', { jobId: kitchenJob, typeKey: 'consultation', title: 'Colour selection', start: soon, end: D.addMinutes(soon, 60), reminderMinutes: 1440 })).data;
  assert.equal(ev.status, 'pending');
  let rem = (await call('GET', '/api/reminders')).data;
  assert.ok(rem.some((r) => r.id === ev.id && r.kind === 'upcoming' && r.needsConfirmation));
  assert.equal((await call('PUT', `/api/events/${ev.id}`, { status: 'confirmed' })).data.status, 'confirmed');
  await call('POST', `/api/events/${ev.id}/dismiss`);
  rem = (await call('GET', '/api/reminders')).data;
  assert.ok(!rem.some((r) => r.id === ev.id));
  const done = (await call('PUT', `/api/events/${ev.id}`, { status: 'completed' })).data;
  assert.ok(done.completedAt);
});

test('marking a job lost cancels its open events', async () => {
  await call('POST', `/api/jobs/${robeJob}/schedule/confirm`);
  const { job } = (await call('GET', `/api/jobs/${robeJob}`)).data;
  await call('PUT', `/api/jobs/${robeJob}`, { ...job, status: 'lost' });
  const events = (await call('GET', `/api/jobs/${robeJob}/schedule`)).data;
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.status === 'cancelled'));
});
