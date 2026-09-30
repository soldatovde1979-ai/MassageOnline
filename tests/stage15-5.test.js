/**
 * stage15-5.test.js — VERSION 1.0 (29.09.2026)
 * Этап 15.5: правила записи (admin.rulesGet / admin.rulesSet) и их действие на витрину,
 * два рабочих окна в дне, отпуск диапазоном дат.
 * Запуск: node tests/stage15-5.test.js
 */
const { createGas } = require('./gas-emulator');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('OK   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

const g = createGas(); const c = g.ctx;
c.setup(); c.setupSecrets('1234');
const call = (action, payload, token, request_id) => c.Api_dispatch({ action, payload: payload || {}, auth: { token: token || null }, request_id });
const T = call('admin.login', { pin: '1234' }).data.token;

let d = new Date(Date.now() + 7 * 86400000);
while (c.weekdayOf(c.dateOf(d)) !== 1) d = new Date(d.getTime() + 86400000);
const day = c.dateOf(d);
const at = (dd, hm) => c.iso(c.toDate(dd, hm));
const next = (dd, n) => c.dateOf(c.addDays(c.toDate(dd, '12:00'), n));
const starts = (dd, dur) => c.Availability_forDay(dd, dur || 60, true, {}).map((s) => c.fmtHM(c.parseIsoStrict(s.start)));

// ---------- правила
const rg = call('admin.rulesGet', {}, T);
const val = (rules, k) => rules.find((r) => r.key === k).value;
ok('rulesGet: 5 правил в единицах мастера', rg.ok && rg.data.rules.length === 5 && val(rg.data.rules, 'lead_time_min') === 2 &&
  val(rg.data.rules, 'cancel_deadline_hours') === 4 && val(rg.data.rules, 'horizon_days') === 30 && val(rg.data.rules, 'buffer_after_min') === 0, rg);
ok('max_bookings_per_day без setupPortal — 0', val(rg.data.rules, 'max_bookings_per_day') === 0);

const rs = call('admin.rulesSet', { values: { buffer_after_min: 30, lead_time_min: 3, horizon_days: 14, max_bookings_per_day: 3 } }, T);
ok('rulesSet сохраняет', rs.ok && c.CFG('buffer_after_min') === '30' && c.CFG('lead_time_min') === '180' && c.CFG('horizon_days') === '14' && c.CFG('max_bookings_per_day') === '3', rs);
ok('public.info видит новые правила сразу', (() => { const p = call('public.info').data; return p.lead_time_min === 180 && p.horizon_days === 14; })());
ok('буфер 45 — отказ', call('admin.rulesSet', { values: { buffer_after_min: 45 } }, T).error.code === 'BAD_REQUEST');
ok('горизонт 500 — отказ', call('admin.rulesSet', { values: { horizon_days: 500 } }, T).error.code === 'BAD_REQUEST');
ok('дробное — отказ', call('admin.rulesSet', { values: { lead_time_min: 1.5 } }, T).error.code === 'BAD_REQUEST');
ok('чужой ключ (PIN, календарь) — отказ', call('admin.rulesSet', { values: { calendar_id: 1 } }, T).error.code === 'BAD_REQUEST');
const partial = call('admin.rulesSet', { values: { cancel_deadline_hours: 6, horizon_days: 999 } }, T);
ok('ошибка в одном — не пишется ничего', !partial.ok && c.CFG('cancel_deadline_hours') === '4', c.CFG('cancel_deadline_hours'));
ok('без токена — UNAUTHORIZED', call('admin.rulesSet', { values: { horizon_days: 20 } }).error.code === 'UNAUTHORIZED');
call('admin.rulesSet', { values: { buffer_after_min: 0, lead_time_min: 0, horizon_days: 30, max_bookings_per_day: 0 } }, T);

// ---------- два окна в дне
const sched = [];
for (let wd = 1; wd <= 7; wd++) sched.push({ weekday: wd, is_working: wd <= 5, start_time: '10:00', end_time: '13:00', note: '' });
sched.push({ weekday: 1, is_working: true, start_time: '16:00', end_time: '19:00', note: '' });
ok('scheduleSet с двумя окнами в понедельник', call('admin.scheduleSet', { rows: sched }, T).ok);
const sg = call('admin.scheduleGet', {}, T).data.schedule.filter((r) => r.weekday === 1 && r.is_working);
ok('scheduleGet отдаёт оба окна', sg.length === 2, sg);
const st = starts(day);
ok('слоты только внутри окон', st.includes('10:00') && st.includes('12:00') && !st.includes('13:00') && !st.includes('14:00') && st.includes('16:00') && st.includes('18:00') && !st.includes('18:30'), st);
const bad = sched.concat([{ weekday: 2, is_working: true, start_time: '12:00', end_time: '14:00', note: '' }]);
ok('пересекающиеся окна — BAD_SLOT', call('admin.scheduleSet', { rows: bad }, T).error.code === 'BAD_SLOT');

// ---------- отпуск: пн–ср включительно
const vac = call('admin.blockCreate', { start_at: at(day, '00:00'), end_at: at(next(day, 3), '00:00'), reason: 'Отпуск' }, T);
ok('отпуск на 3 дня создан', vac.ok, vac);
ok('пн, вт, ср закрыты для клиентов', starts(day).length === 0 && starts(next(day, 1)).length === 0 && starts(next(day, 2)).length === 0);
ok('чт снова открыт', starts(next(day, 3)).length > 0, starts(next(day, 3)));
const ag = call('admin.agenda', { date_from: next(day, 1), date_to: next(day, 1) }, T);
ok('агенда вторника видит отпуск', ag.data.items.some((i) => i.kind === 'block' && i.id === vac.data.block_id));
c.flushOutbox();
ok('отпуск ушёл в календарь одним событием', g.log.calendar.filter((x) => x[0] === 'insert' && /Отпуск/.test(x[2].summary)).length === 1);

// запись внутри будущего отпуска → конфликт
call('admin.blockDelete', { block_id: vac.data.block_id }, T);
const bk = call('booking.create', { service_id: 'svc_massage_60', start_at: at(next(day, 1), '10:00'), slots_count: 2, client: { name: 'Анна', phone: '+79161234567' } }, null, 'rq1');
ok('клиентская запись во вторник', bk.ok, bk);
const vac2 = call('admin.blockCreate', { start_at: at(day, '00:00'), end_at: at(next(day, 3), '00:00'), reason: 'Отпуск' }, T);
ok('отпуск поверх записи — CONFLICT со списком', !vac2.ok && vac2.error.code === 'CONFLICT' && vac2.conflicts.length === 1 && vac2.conflicts[0].title === 'Анна', vac2);

ok('runSelfTests', /ВСЕ ТЕСТЫ ПРОЙДЕНЫ/.test(String(c.runSelfTests())));
console.log('\nИтог: ' + pass + ' OK, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
