/** Тесты этапа 15.1 (мастер: запись, перенос, отметка, поиск). Запуск: node tests/admin-bookings.test.js */
const { createGas } = require('./gas-emulator');
const g = createGas(); const c = g.ctx;
c.setup(); c.setupSecrets('1234');
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('OK   ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); } }
const call = (action, payload, token, request_id) => c.Api_dispatch({ action, payload: payload || {}, auth: { token: token || null }, request_id });

// ближайший понедельник через >= 7 дней (рабочий день по дефолтному графику Пн–Пт 10–20)
let d = new Date(Date.now() + 7 * 86400000);
while (c.weekdayOf(c.dateOf(d)) !== 1) d = new Date(d.getTime() + 86400000);
const day = c.dateOf(d);
const at = (hm) => c.iso(c.toDate(day, hm));

const login = call('admin.login', { pin: '1234' });
ok('вход мастера по PIN', login.ok, login);
const T = login.data.token;

// 1. клиентская запись по-прежнему работает (регрессия 12.5)
const svc = call('services.list');
ok('services.list без цены', svc.ok && !('price' in svc.data.services[0]), svc);
const cb = call('booking.create', { service_id: svc.data.services[0].service_id, start_at: at('12:00'), slots_count: 2, client: { name: 'Анна', phone: '+7 916 123-45-67' } }, null, 'req-client-1');
ok('клиент записался 12:00–13:00', cb.ok && cb.data.end_at === at('13:00'), cb);

// 2. мастер записывает нового клиента
const r1 = call('admin.bookingCreate', { start_at: at('15:00'), slots_count: 3, client: { name: 'Ольга', phone: '89031112233' }, comment: 'позвонила' }, T, 'req-admin-1');
ok('мастер записала Ольгу 15:00–16:30', r1.ok && r1.data.end_at === at('16:30'), r1);
const olga = c.Clients_findByPhone('+79031112233');
ok('клиент создан с provider=admin', olga && olga.identity_provider === 'admin' && olga.name === 'Ольга', olga);
const bk1 = c.Bookings_get(r1.data.booking_id);
ok('источник записи = admin, ждёт календаря', bk1.source === 'admin' && bk1.calendar_sync_status === 'pending', bk1);

// 3. идемпотентность
const r1b = call('admin.bookingCreate', { start_at: at('15:00'), slots_count: 3, client: { name: 'Ольга', phone: '89031112233' } }, T, 'req-admin-1');
ok('повтор request_id не создаёт дубль', r1b.ok && r1b.idempotent_replay === true && c.Bookings_all(true).length === 2, r1b);

// 4. пересечение с записью — жёсткий отказ
const r2 = call('admin.bookingCreate', { start_at: at('12:30'), slots_count: 2, client: { name: 'Иван', phone: '+79035550000' } }, T, 'req-admin-2');
ok('поверх записи Анны — SLOT_TAKEN', !r2.ok && r2.error.code === 'SLOT_TAKEN' && /Анна/.test(r2.error.message), r2);

// 5. вне графика — подтверждение, с force — можно
const r3 = call('admin.bookingCreate', { start_at: at('21:00'), slots_count: 2, client: { name: 'Иван', phone: '+79035550000' } }, T, 'req-admin-3');
ok('21:00 вне графика — CONFLICT с предупреждением', !r3.ok && r3.error.code === 'CONFLICT' && r3.warnings.some(w => w.kind === 'schedule'), r3);
const r3f = call('admin.bookingCreate', { start_at: at('21:00'), slots_count: 2, client: { name: 'Иван', phone: '+79035550000' }, force: true }, T, 'req-admin-3');
ok('с подтверждением — записано', r3f.ok, r3f);

// 6. поверх блокировки — подтверждение
call('admin.blockCreate', { start_at: at('17:00'), end_at: at('18:00'), reason: 'Обед' }, T);
const r4 = call('admin.bookingCreate', { start_at: at('17:00'), slots_count: 2, client: { name: 'Пётр', phone: '+79037770000' } }, T, 'req-admin-4');
ok('поверх блокировки — CONFLICT', !r4.ok && r4.error.code === 'CONFLICT' && r4.warnings.some(w => w.kind === 'block'), r4);

// 7. 1 слот мастеру разрешён, 0 и 9 — нет
const r5 = call('admin.bookingCreate', { start_at: at('10:00'), slots_count: 1, client: { name: 'Пётр', phone: '+79037770000' } }, T, 'req-admin-5');
ok('мастер может записать на 30 минут', r5.ok, r5);
const r6 = call('admin.bookingCreate', { start_at: at('10:30'), slots_count: 9, client: { name: 'Пётр', phone: '+79037770000' } }, T, 'req-admin-6');
ok('9 слотов — BAD_SLOT', !r6.ok && r6.error.code === 'BAD_SLOT', r6);

// 8. публикация в календарь и перенос
c.flushOutbox();
const ev1 = c.Bookings_get(r1.data.booking_id).gcal_event_id;
ok('Outbox создал событие для записи мастера', !!ev1, c.Bookings_get(r1.data.booking_id));
const verBefore = String(c.Bookings_get(r1.data.booking_id).manage_token_ver);
const mv = call('admin.bookingMove', { booking_id: r1.data.booking_id, start_at: at('15:30') }, T);
ok('перенос на 30 мин позже (пересекает сам себя) — ок, длительность сохранена', mv.ok && mv.data.start_at === at('15:30') && mv.data.end_at === at('17:00'), mv);
const bk1m = c.Bookings_get(r1.data.booking_id);
ok('после переноса — pending, ссылка клиента не сломана', bk1m.calendar_sync_status === 'pending' && String(bk1m.manage_token_ver) === verBefore, bk1m);
g.log.calendar.length = 0; c.flushOutbox();
ok('Outbox пропатчил событие, а не создал новое', g.log.calendar.some(x => x[0] === 'patch' && x[1] === ev1) && !g.log.calendar.some(x => x[0] === 'insert' && x[2].extendedProperties && x[2].extendedProperties.private.booking_id === r1.data.booking_id), g.log.calendar.map(x => x.slice(0, 2)));
const mv2 = call('admin.bookingMove', { booking_id: r1.data.booking_id, start_at: at('12:00') }, T);
ok('перенос на время Анны — SLOT_TAKEN', !mv2.ok && mv2.error.code === 'SLOT_TAKEN', mv2);

// 9. отметки
const mk1 = call('admin.bookingMark', { booking_id: r1.data.booking_id, status: 'no_show' }, T);
ok('будущую запись отметить нельзя — TOO_EARLY', !mk1.ok && mk1.error.code === 'TOO_EARLY', mk1);
const past = new Date(Date.now() - 3 * 3600000); past.setMinutes(past.getMinutes() < 30 ? 0 : 30, 0, 0);
const pr = call('admin.bookingCreate', { start_at: c.iso(past), slots_count: 2, client: { name: 'Вера', phone: '+79030001122' }, force: true }, T, 'req-admin-past');
ok('задним числом — только с подтверждением', pr.ok, pr);
const mk2 = call('admin.bookingMark', { booking_id: pr.data.booking_id, status: 'no_show' }, T);
ok('прошедшую — «не пришла»', mk2.ok && c.Bookings_get(pr.data.booking_id).status === 'no_show', mk2);
const ag = call('admin.agenda', { date_from: c.dateOf(past), date_to: c.dateOf(past) }, T);
ok('агенда показывает no_show', ag.ok && ag.data.items.some(i => i.id === pr.data.booking_id && i.status === 'no_show' && i.slots === 2), ag.ok ? ag.data.items : ag);
const mk3 = call('admin.bookingMark', { booking_id: pr.data.booking_id, status: 'confirmed' }, T);
ok('отметку можно откатить', mk3.ok && c.Bookings_get(pr.data.booking_id).status === 'confirmed', mk3);

// 10. поиск клиентов
const f1 = call('admin.clientsFind', { q: 'оль' }, T);
ok('поиск по части имени', f1.ok && f1.data.clients.length === 1 && f1.data.clients[0].name === 'Ольга', f1);
const f2 = call('admin.clientsFind', { q: '555' }, T);
ok('поиск по цифрам телефона', f2.ok && f2.data.clients.some(x => x.name === 'Иван'), f2);
const r7 = call('admin.bookingCreate', { start_at: at('19:00'), slots_count: 2, client: { client_id: olga.client_id } }, T, 'req-admin-7');
ok('запись существующего клиента по client_id', r7.ok && r7.data.client.name === 'Ольга' && c.Clients_all().filter(x => x.phone === '+79031112233').length === 1, r7);

// 11. без токена — отказ
const u = call('admin.bookingCreate', { start_at: at('11:00'), slots_count: 2, client: { name: 'X', phone: '+79030000000' } }, null, 'req-x');
ok('без токена — UNAUTHORIZED', !u.ok && u.error.code === 'UNAUTHORIZED', u);

// 12. самотесты движка не сломаны
ok('runSelfTests', /ВСЕ ТЕСТЫ ПРОЙДЕНЫ/.test(String(c.runSelfTests())));

console.log('\nИтог: ' + pass + ' OK, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
