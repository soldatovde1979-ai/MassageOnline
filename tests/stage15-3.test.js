/**
 * stage15-3.test.js — VERSION 1.0 (30.09.2026)
 * Этап 15.3, Telegram: уведомления мастеру с кнопками, вечерняя сводка, напоминания клиентам,
 * ошибки разработчику, chat_id клиента из Mini App, telegramFindChats / telegramTest, триггеры.
 * Запуск: node tests/stage15-3.test.js
 */
const crypto = require('crypto');
const { createGas } = require('./gas-emulator');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('OK   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 500) : '')); }
}

const BOT = '123456:TEST-token';
const g = createGas({ props: { TELEGRAM_CLIENT_BOT_TOKEN: BOT } });
const c = g.ctx;
const setupMsg = c.setup(); c.setupSecrets('1234'); c.setupPortal();
ok('setup: новые ключи config', c.CFG_opt('digest_hour', '') === '20' && c.CFG_all().hasOwnProperty('dev_tg_chat_id'));
ok('setup: колонки напоминаний в bookings', c.Sheet_head('bookings').includes('reminder_24_at') && c.Sheet_head('bookings').includes('reminder_2_at'));

c.CFG_set('web_app_url', 'https://script.google.com/macros/s/TEST/exec');
c.CFG_set('notify_telegram_enabled', 'TRUE');
c.CFG_set('notify_email_enabled', 'FALSE');
c.CFG_set('master_tg_chat_id', '1001');
c.CFG_set('lead_time_min', '0');
c.CFG_set('master_name', 'Мария');
c.CFG_set('studio_address', 'ул. Ленина, 5');

const call = (action, payload, token, request_id) =>
  c.Api_dispatch({ action, payload: payload || {}, auth: { token: token || null }, request_id: request_id || crypto.randomUUID() });
const T = call('admin.login', { pin: '1234' }).data.token;
const sent = () => g.log.fetch.filter((f) => /sendMessage$/.test(f[0])).map((f) => JSON.parse(f[1].payload));
const clear = () => { g.log.fetch.length = 0; };
const svc = 'svc_massage_60';

let d = new Date(Date.now() + 7 * 86400000);
while (c.weekdayOf(c.dateOf(d)) !== 1) d = new Date(d.getTime() + 86400000);
const day = c.dateOf(d);
const at = (dd, hm) => c.iso(c.toDate(dd, hm));

// ---------- новая запись клиента → мастеру в Telegram
clear();
const b1 = call('booking.create', { service_id: svc, start_at: at(day, '12:00'), slots_count: 2, client: { name: 'Анна', phone: '+79161234567' }, comment: 'шея <болит>' });
ok('клиент записался', b1.ok, b1);
c.flushOutbox();
let m = sent();
ok('мастеру ушло одно сообщение', m.length === 1 && m[0].chat_id === '1001', m);
ok('HTML: заголовок жирным, спецсимволы экранированы', m[0].parse_mode === 'HTML' && /<b>Новая запись: пн /.test(m[0].text) && /шея &lt;болит&gt;/.test(m[0].text), m[0].text);
ok('телефон в тексте', /\+7 916 123-45-67/.test(m[0].text));
const btns = m[0].reply_markup.inline_keyboard[0];
ok('кнопка «Открыть день» ведёт в админку на этот день', btns[0].text === 'Открыть день' && btns[0].url === 'https://script.google.com/macros/s/TEST/exec?r=admin&d=' + day, btns);
ok('кнопка «Написать в Telegram»', btns[1].url === 'https://t.me/+79161234567', btns);

// ---------- запись мастером — без уведомления
clear();
call('admin.bookingCreate', { start_at: at(day, '15:00'), slots_count: 2, client: { name: 'Ольга', phone: '+79031112233' } }, T, 'adm1');
c.flushOutbox();
ok('свою запись мастер в Telegram не получает', sent().length === 0, sent());

// ---------- заметка мастера попадает в уведомление
const anna = c.Clients_findByPhone('+79161234567');
call('admin.clientUpdate', { client_id: anna.client_id, notes: 'давление сильнее' }, T);

// ---------- перенос клиентом
clear();
const tok = c.Security_buildManageToken(c.Bookings_get(b1.data.booking_id));
const rs = c.Api_dispatch({ action: 'booking.reschedule', auth: { token: tok }, payload: { start_at: at(day, '17:00') } });
ok('клиент перенёс запись', rs.ok, rs);
m = sent();
ok('мастеру — «Перенос» с «Было»', m.length === 1 && /Перенос: пн .* 17:00–18:00/.test(m[0].text) && /Было: пн .* 12:00–13:00/.test(m[0].text), m);

// ---------- отмена клиентом
clear();
const tok2 = c.Security_buildManageToken(c.Bookings_get(b1.data.booking_id));
c.Api_dispatch({ action: 'booking.cancel', auth: { token: tok2 }, payload: {} });
ok('мастеру — «Отмена клиентом»', sent().length === 1 && /Отмена клиентом/.test(sent()[0].text));

// ---------- ошибка календаря: разработчику, если он задан
const b2 = call('booking.create', { service_id: svc, start_at: at(day, '10:00'), slots_count: 2, client: { name: 'Вера', phone: '+79030001122' } });
clear();
c.Outbox_fail_(Object.assign({}, c.Bookings_get(b2.data.booking_id), { calendar_sync_attempts: 4 }), new Error('quota'));
ok('без dev_tg_chat_id — мастеру', sent().length === 1 && sent()[0].chat_id === '1001' && /не попала в календарь/.test(sent()[0].text));
c.CFG_set('dev_tg_chat_id', '2002');
clear();
c.Outbox_fail_(Object.assign({}, c.Bookings_get(b2.data.booking_id), { calendar_sync_attempts: 4 }), new Error('quota2'));
ok('с dev_tg_chat_id — только разработчику', sent().length === 1 && sent()[0].chat_id === '2002' && /quota2/.test(sent()[0].text), sent());

// ---------- INTERNAL в API → разработчику, с защитой от повторов
clear();
const saved = c.Services_list;
c.ROUTES['public.info'] = () => { throw c.apiError('INTERNAL', 'лист сломан'); };
call('public.info'); call('public.info');
ok('INTERNAL → одно сообщение разработчику за 30 минут', sent().length === 1 && sent()[0].chat_id === '2002' && /public\.info: лист сломан/.test(sent()[0].text), sent());
c.ROUTES['public.info'] = c.Api_publicInfo;
clear();
call('booking.create', { service_id: svc, start_at: at(day, '10:00'), slots_count: 2, client: { name: 'Вера', phone: '+79030001122' } });
ok('обычная ошибка клиента (SLOT_TAKEN) разработчику не уходит', sent().length === 0, sent());

// ---------- вечерняя сводка «на завтра»
const tomorrow = c.dateOf(c.addDays(new Date(), 1));
c.Schedule_set([1, 2, 3, 4, 5, 6, 7].map((w) => ({ weekday: w, is_working: true, start_time: '00:00', end_time: '23:30', note: '' })));
clear();
c.eveningDigest();
m = sent();
ok('пустой завтрашний день — тихое «Свободный день»', m.length === 1 && m[0].disable_notification === true && /записей нет/.test(m[0].text) && /Свободный день/.test(m[0].text), m);
call('admin.bookingCreate', { start_at: at(tomorrow, '18:00'), slots_count: 3, client: { client_id: anna.client_id }, comment: 'после работы' }, T, 'adm-t1');
call('admin.bookingCreate', { start_at: at(tomorrow, '11:00'), slots_count: 2, client: { name: 'Ольга', phone: '+79031112233' } }, T, 'adm-t2');
clear();
c.eveningDigest();
m = sent();
const dt = m[0] && m[0].text;
ok('сводка: обе записи по времени, заметка и комментарий', m.length === 1 && /записей — 2/.test(dt) && dt.indexOf('11:00–12:00') < dt.indexOf('18:00–19:30') && /📝 давление сильнее/.test(dt) && /после работы/.test(dt), dt);
ok('сводка: кнопка на завтрашний день', m[0].reply_markup.inline_keyboard[0][0].url.endsWith('d=' + tomorrow));
// завтрашние записи больше не нужны — убираем, чтобы тесты напоминаний не зависели от времени суток
c.Bookings_all(true).filter((b) => b.request_id === 'adm-t1' || b.request_id === 'adm-t2')
  .forEach((b) => call('admin.bookingCancel', { booking_id: b.booking_id }, T));
ok('dailyMaintenance больше не шлёт сводку', (clear(), c.dailyMaintenance(), sent().length === 0), sent());

// ---------- chat_id клиента из Mini App
function signInitData(fields, token) {
  const dcs = Object.keys(fields).sort().map((k) => k + '=' + fields[k]).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return Object.keys(fields).map((k) => k + '=' + encodeURIComponent(fields[k])).join('&') + '&hash=' + hash;
}
const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 5550001, first_name: 'Нина' }) }, BOT);
const nb = call('booking.create', { service_id: svc, start_at: at(day, '19:00'), slots_count: 2, tg_init_data: initData, client: { name: 'Нина', phone: '+79035550001' } });
ok('запись из Mini App', nb.ok, nb);
const nina = c.Clients_findByPhone('+79035550001');
ok('новому клиенту из Mini App записан tg_chat_id', String(nina.tg_chat_id) === '5550001', nina);
const initAnna = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 5550002, first_name: 'Анна' }) }, BOT);
call('booking.create', { service_id: svc, start_at: at(next(day, 1), '12:00'), slots_count: 2, tg_init_data: initAnna, client: { name: 'Анна', phone: '+79161234567' } });
ok('известному клиенту tg_chat_id дописан при записи из Mini App', String(c.Clients_findByPhone('+79161234567').tg_chat_id) === '5550002');
function next(dd, n) { return c.dateOf(c.addDays(c.toDate(dd, '12:00'), n)); }

// ---------- напоминания
const half = (msAhead) => { const x = new Date(Date.now() + msAhead); x.setMinutes(x.getMinutes() < 30 ? 0 : 30, 0, 0); return x; };
const mkBooking = (start, createdAgoH, clientId) => {
  const b = c.Bookings_insert({
    booking_id: crypto.randomUUID(), request_id: crypto.randomUUID(), client_id: clientId, service_id: svc,
    start_at: c.iso(start), end_at: c.iso(c.addMin(start, 60)), status: 'confirmed', comment: '', source: 'web',
    calendar_sync_status: 'synced', gcal_event_id: '', created_at: c.iso(new Date(Date.now() - createdAgoH * 3600000))
  });
  return b.booking_id;
};
const ninaId = nina.client_id;
const olga = c.Clients_findByPhone('+79031112233');
const r24 = mkBooking(half(20 * 3600000), 72, ninaId);        // через ~20 ч, записалась 3 дня назад
const r2 = mkBooking(half(90 * 60000), 72, ninaId);            // через 1–1,5 ч
const fresh = mkBooking(half(18 * 3600000), 1, ninaId);        // записалась час назад — «за сутки» не нужно
const noTg = mkBooking(half(21 * 3600000), 72, olga.client_id); // у Ольги нет Telegram
clear();
const n1 = c.sendReminders();
m = sent();
const toNina = m.filter((x) => x.chat_id === '5550001');
ok('ушло 2 напоминания Нине, Ольге — ничего', n1 === 2 && toNina.length === 2 && m.length === 2, m.map((x) => x.chat_id + ' ' + x.text.slice(0, 40)));
const t24 = toNina.find((x) => c.Bookings_get(r24).reminder_24_at && /Перенести/.test(JSON.stringify(x.reply_markup || {})));
ok('за сутки: текст, адрес, кнопка «Перенести или отменить»', t24 && /^Нина, напоминаю: (сегодня|завтра) в <b>\d\d:\d\d<\/b> — массаж у Мария\./.test(t24.text) && /ул\. Ленина, 5/.test(t24.text), toNina);
const t2 = toNina.find((x) => !x.reply_markup);
ok('за 2 часа: без кнопки (поздно отменять), «позвоните мастеру»', t2 && /позвоните мастеру/.test(t2.text) && !!c.Bookings_get(r2).reminder_2_at, toNina);
ok('записавшейся час назад «за сутки» не шлём', !c.Bookings_get(fresh).reminder_24_at);
clear();
ok('повторный запуск ничего не шлёт', c.sendReminders() === 0 && sent().length === 0);
const mvR = call('admin.bookingMove', { booking_id: r24, start_at: c.iso(half(16 * 3600000)), force: true }, T);
ok('перенос мастером', mvR.ok, mvR);
ok('перенос сбрасывает отметку', c.Bookings_get(r24).reminder_24_at === '');
clear();
ok('после переноса напоминание уходит заново', c.sendReminders() === 1 && sent()[0].chat_id === '5550001');
c.CFG_set('notify_telegram_enabled', 'FALSE');
const r24b = mkBooking(half(19 * 3600000), 72, ninaId);
clear();
ok('Telegram выключен — напоминаний нет', c.sendReminders() === 0 && sent().length === 0 && !c.Bookings_get(r24b).reminder_24_at);
c.CFG_set('notify_telegram_enabled', 'TRUE');
c.CFG_set('client_address_form', 'ty');
const r24c = mkBooking(half(23 * 3600000), 72, ninaId);
clear(); c.sendReminders();
ok('обращение на «ты»', sent().some((x) => /перенеси или отмени/.test(x.text)), sent().map((x) => x.text));

// ---------- telegramFindChats / telegramTest
const realFetch = c.UrlFetchApp.fetch;
c.UrlFetchApp.fetch = (url, o) => {
  if (/getUpdates$/.test(url)) return { getContentText: () => JSON.stringify({ ok: true, result: [
    { message: { chat: { id: 1001, first_name: 'Мария' } } }, { message: { chat: { id: 2002, first_name: 'Дмитрий', username: 'dima' } } },
    { message: { chat: { id: 1001, first_name: 'Мария' } } }] }) };
  return realFetch(url, o);
};
const fc = c.telegramFindChats();
ok('telegramFindChats: два чата без повторов', /1001 — Мария/.test(fc) && /2002 — Дмитрий @dima/.test(fc) && fc.split('\n').length === 3, fc);
c.UrlFetchApp.fetch = realFetch;
clear();
const tt = c.telegramTest();
ok('telegramTest: мастеру и разработчику', /мастеру: отправлено/.test(tt) && /разработчику: отправлено/.test(tt) && sent().length === 2, tt);

// ---------- триггеры
ok('installTriggers ставит напоминания и сводку', /sendReminders 15 мин, eveningDigest 20:00/.test(c.installTriggers()));

// ---------- миграция старой таблицы: колонки напоминаний дописываются
{
  const g0 = createGas(); const c0 = g0.ctx; c0.setup();
  const sh = g0.ss.getSheetByName('bookings');
  sh._rows[0].length = sh._rows[0].length - 2;
  ok('повторный setup() дописывает reminder_*', /bookings: добавлены колонки reminder_24_at, reminder_2_at/.test(c0.setup()));
  c0.CFG_set('notify_telegram_enabled', 'TRUE');
  sh._rows[0].length = sh._rows[0].length - 2;
  ok('без колонок sendReminders не падает', c0.sendReminders() === 0);
}

ok('runSelfTests', /ВСЕ ТЕСТЫ ПРОЙДЕНЫ/.test(String(c.runSelfTests())));
console.log('\nИтог: ' + pass + ' OK, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
