/**
 * stage15-4.test.js — VERSION 1.0 (29.09.2026)
 * Этап 15.4: карточка клиента — admin.clientGet / admin.clientUpdate, заметка в агенде,
 * миграция колонки notes повторным setup(), обезличивание стирает заметку.
 * Запуск: node tests/stage15-4.test.js
 */
const { createGas } = require('./gas-emulator');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('OK   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

// ---------- миграция: таблица «до 15.4» без колонки notes
{
  const g0 = createGas(); const c0 = g0.ctx;
  c0.setup();
  const sh = g0.ss.getSheetByName('clients');
  const head = sh._rows[0];
  head.splice(head.indexOf('notes'), 1);               // имитируем старую шапку
  sh._rows.push(['cl-old', '+79160000001', 'Старая', 'local', '', '', '', '', '', 1, 'FALSE']);
  const msg = c0.setup();
  ok('повторный setup() дописывает колонку notes', /clients: добавлены колонки notes/.test(msg), msg);
  ok('данные старого клиента не сдвинулись', c0.Clients_get('cl-old').name === 'Старая' && c0.Clients_get('cl-old').notes === '', c0.Clients_get('cl-old'));
  ok('третий setup() ничего не добавляет', !/добавлены колонки/.test(c0.setup()));
}

const g = createGas(); const c = g.ctx;
c.setup(); c.setupSecrets('1234');
const call = (action, payload, token, request_id) => c.Api_dispatch({ action, payload: payload || {}, auth: { token: token || null }, request_id });
const T = call('admin.login', { pin: '1234' }).data.token;

let d = new Date(Date.now() + 7 * 86400000);
while (c.weekdayOf(c.dateOf(d)) !== 1) d = new Date(d.getTime() + 86400000);
const day = c.dateOf(d);
const at = (hm) => c.iso(c.toDate(day, hm));

// история: будущая запись, прошедшая «пришла», прошедшая «не пришла», отменённая
const fut = call('admin.bookingCreate', { start_at: at('12:00'), slots_count: 2, client: { name: 'Анна', phone: '+79161234567' }, comment: 'шея' }, T, 'r1');
const anna = c.Clients_findByPhone('+79161234567');
const pastAt = (hAgo) => { const p = new Date(Date.now() - hAgo * 3600000); p.setMinutes(p.getMinutes() < 30 ? 0 : 30, 0, 0); return c.iso(p); };
const p1 = call('admin.bookingCreate', { start_at: pastAt(72), slots_count: 2, client: { client_id: anna.client_id }, force: true }, T, 'r2');
const p2 = call('admin.bookingCreate', { start_at: pastAt(48), slots_count: 2, client: { client_id: anna.client_id }, force: true }, T, 'r3');
call('admin.bookingMark', { booking_id: p1.data.booking_id, status: 'completed' }, T);
call('admin.bookingMark', { booking_id: p2.data.booking_id, status: 'no_show' }, T);
const cx = call('admin.bookingCreate', { start_at: at('15:00'), slots_count: 2, client: { client_id: anna.client_id } }, T, 'r4');
call('admin.bookingCancel', { booking_id: cx.data.booking_id }, T);
// чужая запись не должна попасть в карточку
call('admin.bookingCreate', { start_at: at('17:00'), slots_count: 2, client: { name: 'Ольга', phone: '+79031112233' } }, T, 'r5');

const card = call('admin.clientGet', { client_id: anna.client_id }, T);
ok('карточка открывается', card.ok, card);
const s = card.data.stats;
ok('счётчики: 1 визит, 1 неявка, 1 отмена, 1 впереди', s.completed === 1 && s.no_show === 1 && s.cancelled === 1 && s.upcoming === 1, s);
ok('история только Анны, свежие сверху', card.data.history.length === 4 && card.data.history[0].start_at >= card.data.history[1].start_at &&
  card.data.history.every((h) => [fut, p1, p2, cx].some((r) => r.data.booking_id === h.booking_id)), card.data.history);
ok('ближайшая и последняя даты', card.data.next_visit_at === at('12:00') && card.data.last_visit_at === p1.data.start_at, card.data);
ok('комментарий записи виден в истории', card.data.history.some((h) => h.comment === 'шея'));
ok('заметок пока нет', card.data.client.notes === '');

// архив тоже попадает в историю
const arch = Object.assign({}, c.Bookings_get(p1.data.booking_id), { booking_id: 'old-1', start_at: '2025-01-10T12:00:00+03:00', end_at: '2025-01-10T13:00:00+03:00', status: 'completed' });
c.Sheet_append('bookings_archive', arch);
const card2 = call('admin.clientGet', { client_id: anna.client_id }, T);
ok('архивная запись в истории и в счётчике', card2.data.history.some((h) => h.booking_id === 'old-1') && card2.data.stats.completed === 2 && card2.data.history_total === 5, card2.data.stats);

// заметки
const up = call('admin.clientUpdate', { client_id: anna.client_id, notes: 'Давление сильнее. Шея.' }, T);
ok('заметка сохраняется', up.ok && c.Clients_get(anna.client_id).notes === 'Давление сильнее. Шея.', up);
const long = call('admin.clientUpdate', { client_id: anna.client_id, notes: 'x'.repeat(2500) }, T);
ok('заметка обрезается до 2000', long.ok && c.Clients_get(anna.client_id).notes.length === 2000);
call('admin.clientUpdate', { client_id: anna.client_id, notes: 'Давление сильнее. Шея.' }, T);
ok('пустой patch — BAD_REQUEST', call('admin.clientUpdate', { client_id: anna.client_id }, T).error.code === 'BAD_REQUEST');
ok('имя короче 2 — BAD_REQUEST', call('admin.clientUpdate', { client_id: anna.client_id, name: 'А' }, T).error.code === 'BAD_REQUEST');
ok('переименование', call('admin.clientUpdate', { client_id: anna.client_id, name: 'Анна Петрова' }, T).ok && c.Clients_get(anna.client_id).name === 'Анна Петрова');
ok('неизвестный клиент — NOT_FOUND', call('admin.clientGet', { client_id: 'nope' }, T).error.code === 'NOT_FOUND');

// агенда отдаёт начало заметки
const ag = call('admin.agenda', { date_from: day, date_to: day }, T);
const it = ag.data.items.find((i) => i.id === fut.data.booking_id);
ok('агенда: client_note у записи', it && it.client_note === 'Давление сильнее. Шея.', it);
ok('агенда: у Ольги заметки нет', ag.data.items.find((i) => i.name === 'Ольга').client_note === '');

// заметки не утекают клиенту
const pub = JSON.stringify(call('client.bookings', { tokens: [] })) + JSON.stringify(call('public.info', {}));
ok('клиентские маршруты не отдают заметки', !/Давление/.test(pub));

// без токена
ok('clientGet без токена — UNAUTHORIZED', call('admin.clientGet', { client_id: anna.client_id }).error.code === 'UNAUTHORIZED');
ok('clientUpdate без токена — UNAUTHORIZED', call('admin.clientUpdate', { client_id: anna.client_id, notes: 'x' }).error.code === 'UNAUTHORIZED');

// обезличивание стирает заметку
c.gdprForget('+79161234567');
ok('gdprForget стирает заметку', c.Clients_get(anna.client_id).notes === '' && c.Clients_get(anna.client_id).name === 'Удалено');

ok('runSelfTests', /ВСЕ ТЕСТЫ ПРОЙДЕНЫ/.test(String(c.runSelfTests())));

console.log('\nИтог: ' + pass + ' OK, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
