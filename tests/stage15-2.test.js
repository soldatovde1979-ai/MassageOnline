/**
 * stage15-2.test.js — VERSION 1.0 (29.09.2026)
 * Сервер этапа 15.2: движок 1.1 (буфер, лимит дня), public.info, client.bookings, ленивый booking.restore,
 * вебхук бота в doPost, запись-призрак в Outbox, Telegram: подпись initData и отправка с кнопками.
 * Запуск: node tests/stage15-2.test.js
 */
const crypto = require('crypto');
const { createGas } = require('./gas-emulator');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('OK   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

const BOT = '123456:TEST-token';
const g = createGas({ props: { TELEGRAM_CLIENT_BOT_TOKEN: BOT } });
const c = g.ctx;
c.setup(); c.setupSecrets('1234');
ok('setupPortal добавляет ключи витрины', /Добавлены ключи config/.test(c.setupPortal()));
ok('setupPortal идемпотентна', /уже есть/.test(c.setupPortal()));
c.CFG_set('web_app_url', 'https://script.google.com/macros/s/TEST/exec');
c.CFG_set('lead_time_min', '0');

const call = (action, payload, token, request_id) =>
  c.Api_dispatch({ action, payload: payload || {}, auth: { token: token || null }, request_id: request_id || crypto.randomUUID() });

let d = new Date(Date.now() + 7 * 86400000);
while (c.weekdayOf(c.dateOf(d)) !== 1) d = new Date(d.getTime() + 86400000);
const day = c.dateOf(d);
const at = (hm) => c.iso(c.toDate(day, hm));
const starts = (dur, opts) => c.Availability_forDay(day, dur, true, opts).map((s) => c.fmtHM(c.parseIsoStrict(s.start)));
const svcId = c.Services_list(true)[0].service_id;

// ---------- движок 1.1
c.Schedule_set([1, 2, 3, 4, 5, 6, 7].map((w) => ({ weekday: w, is_working: w === 1, start_time: '10:00', end_time: '12:00', note: '' })));
c.CFG_invalidate();
c.CFG_set('buffer_after_min', '30');
ok('буфер не съедает последний сеанс дня', JSON.stringify(starts(60)) === JSON.stringify(['10:00', '10:30', '11:00']), starts(60));
c.CFG_set('buffer_after_min', '0');
c.Schedule_set([1, 2, 3, 4, 5, 6, 7].map((w) => ({ weekday: w, is_working: w <= 5, start_time: '10:00', end_time: '20:00', note: '' })));
c.CFG_invalidate();

c.CFG_set('max_bookings_per_day', '1');
const b1 = call('booking.create', { service_id: svcId, start_at: at('12:00'), slots_count: 2, client: { name: 'Анна', phone: '+7 916 123-45-67' } });
ok('запись клиента создана', b1.ok, b1);
ok('лимит 1 сеанс в день закрывает день для клиентов', starts(60).length === 0, starts(60));
ok('мастеру лимит не мешает (ignoreDailyLimit)', starts(60, { ignoreDailyLimit: true }).length > 0);
c.CFG_set('max_bookings_per_day', '0');
ok('лимит 0 — без ограничения', starts(60).length > 0);

c.CFG_set('lead_time_min', String(60 * 24 * 30));
ok('lead_time отсекает клиентские старты', starts(60).length === 0);
ok('ignoreLeadTime для мастера', starts(60, { ignoreLeadTime: true }).length > 0);
c.CFG_set('lead_time_min', '0');

// ---------- public.info
const info = call('public.info');
ok('public.info отвечает', info.ok, info);
ok('public.info: правила записи и услуги без цен', info.data.min_slots === 2 && info.data.max_slots === 8 &&
  info.data.services.length > 0 && !('price' in info.data.services[0]), info.data);
ok('public.info: без 54_Restore окно возврата = 0', info.data.restore_window_min === 0, info.data.restore_window_min);
ok('public.info не отдаёт код домофона', !('studio_after_booking' in info.data));

// ---------- client.bookings
const tokenOf = (url) => decodeURIComponent(String(url).split('t=')[1] || '');
const t1 = tokenOf(b1.data.manage_url);
let cb = call('client.bookings', { tokens: [t1, 'bad.token.x'] });
ok('client.bookings: своя запись видна', cb.ok && cb.data.items.length === 1 && cb.data.items[0].booking_id === b1.data.booking_id, cb);
ok('client.bookings: битая ссылка — в invalid, не ошибка запроса', cb.data.invalid.length === 1 && !!cb.data.invalid[0].code, cb.data.invalid);
const it = cb.data.items[0];
ok('client.bookings: длительность фактическая (1 ч)', it.duration_min === 60, it);
ok('client.bookings: можно отменить и перенести', it.can_cancel && it.can_reschedule && !it.can_restore, it);

c.CFG_set('studio_after_booking', 'Домофон 42, 3 этаж');
cb = call('client.bookings', { tokens: [t1] });
ok('код домофона — только в своей активной записи', cb.data.items[0].after_booking === 'Домофон 42, 3 этаж');

const cancel = call('booking.cancel', {}, t1);
ok('отмена клиентом', cancel.ok, cancel);
cb = call('client.bookings', { tokens: [t1] });
ok('после отмены: статус и нет кнопки вернуть без 54_Restore', cb.data.items[0].status === 'cancelled_by_client' && !cb.data.items[0].can_restore && !cb.data.items[0].after_booking, cb.data.items[0]);
const noRestore = call('booking.restore', {}, t1);
ok('booking.restore без 54_Restore → UNKNOWN_ACTION, проект не падает', !noRestore.ok && noRestore.error.code === 'UNKNOWN_ACTION', noRestore);

// эмулируем залитый 54_Restore.gs: функция появляется в глобальной области ПОСЛЕ роутера
let restoreCalled = 0;
c.Api_bookingRestore = function (req) { restoreCalled++; c.Bookings_update(c.Security_verifyManageToken(req.auth.token).booking_id, { status: 'confirmed', cancelled_at: '', cancel_reason: '' }); return { ok: true, data: {} }; };
cb = call('client.bookings', { tokens: [t1] });
ok('с 54_Restore: «Вернуть» доступно 30 минут', cb.data.items[0].can_restore && cb.data.items[0].restore_until, cb.data.items[0]);
ok('public.info: окно возврата 30 мин', call('public.info').data.restore_window_min === 30);
const rs = call('booking.restore', {}, t1);
ok('booking.restore вызывается лениво через роутер', rs.ok && restoreCalled === 1, rs);

// окно возврата истекло
call('booking.cancel', {}, t1);
c.Bookings_update(b1.data.booking_id, { cancelled_at: c.iso(new Date(Date.now() - 31 * 60000)) });
cb = call('client.bookings', { tokens: [t1] });
ok('через 31 минуту вернуть нельзя', !cb.data.items[0].can_restore, cb.data.items[0]);

// ---------- Outbox: отмена до публикации не создаёт событие-призрак
g.log.calendar.length = 0; g.log.mail.length = 0;
c.CFG_set('master_email', 'master@example.com');
const b2 = call('booking.create', { service_id: svcId, start_at: at('15:00'), slots_count: 2, client: { name: 'Ольга', phone: '+79031112233' } });
call('booking.cancel', {}, tokenOf(b2.data.manage_url));
c.flushOutbox();
ok('отменённая до публикации запись не попадает в календарь', !g.log.calendar.some((x) => x[0] === 'insert'), g.log.calendar);
ok('и мастеру не приходит «Новая запись»', !g.log.mail.some((m) => /Новая запись/.test(JSON.stringify(m))), g.log.mail);
const b3 = call('booking.create', { service_id: svcId, start_at: at('17:00'), slots_count: 2, client: { name: 'Ольга', phone: '+79031112233' } });
c.flushOutbox();
ok('обычная запись публикуется как раньше', g.log.calendar.some((x) => x[0] === 'insert'), g.log.calendar);

// ---------- doPost: вебхук бота подключается лениво
const post = (q, body) => JSON.parse(c.doPost({ parameter: q, postData: { contents: JSON.stringify(body) } }).getContent());
ok('doPost ?r=tg без 71_TelegramClient — 200 ok', post({ r: 'tg', s: 'x' }, { update_id: 1 }).ok === true);
let hookArgs = null;
c.TgClient_webhook = (upd, s) => { hookArgs = [upd, s]; return { ok: true }; };
post({ r: 'tg', s: 'sec' }, { update_id: 7 });
ok('doPost ?r=tg передаёт апдейт и секрет в 71_TelegramClient', hookArgs && hookArgs[0].update_id === 7 && hookArgs[1] === 'sec', hookArgs);
ok('doPost без r — обычный API', post({}, { action: 'public.info', payload: {} }).ok === true);

// ---------- Telegram: подпись initData
function signInitData(fields, token) {
  const dcs = Object.keys(fields).sort().map((k) => k + '=' + fields[k]).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return Object.keys(fields).map((k) => k + '=' + encodeURIComponent(fields[k])).join('&') + '&hash=' + hash;
}
const now = Math.floor(Date.now() / 1000);
const fields = { auth_date: String(now), query_id: 'AAH', user: JSON.stringify({ id: 777, first_name: 'Анна', username: 'anna' }), signature: 'sig' };
const good = signInitData(fields, BOT);
const u = c.Telegram_verifyInitData(good);
ok('initData с верной подписью принят', u && u.id === 777 && u.first_name === 'Анна', u);
ok('подменённый user отклонён', c.Telegram_verifyInitData(good.replace('777', '778')) === null);
ok('подпись чужим токеном отклонена', c.Telegram_verifyInitData(signInitData(fields, '999:OTHER')) === null);
ok('initData старше суток отклонён', c.Telegram_verifyInitData(signInitData(Object.assign({}, fields, { auth_date: String(now - 90000) }), BOT)) === null);
ok('мусор не роняет проверку', c.Telegram_verifyInitData('%E0%A4%A&hash=zz') === null);

g.log.fetch.length = 0;
c.Telegram_sendMessage('555', 'Новая запись <b>Анна</b>', { html: true, buttons: [[{ text: 'Открыть день', url: 'https://example.com' }]] });
const sent = g.log.fetch[0] && JSON.parse(g.log.fetch[0][1].payload);
ok('sendMessage: токен клиентского бота, HTML, кнопки', g.log.fetch[0][0].indexOf(BOT) > 0 && sent.parse_mode === 'HTML' && sent.reply_markup.inline_keyboard[0][0].url === 'https://example.com', sent);
ok('экранирование HTML', c.Telegram_escapeHtml('<a&b>') === '&lt;a&amp;b&gt;');

// ---------- регрессия: самотесты движка
const st = String(c.runSelfTests());
ok('runSelfTests проходят с движком 1.1', /ВСЕ ТЕСТЫ ПРОЙДЕНЫ/.test(st), st.split('\n').filter((l) => /FAIL/.test(l)));

console.log('\nИтог: ' + pass + ' OK, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
