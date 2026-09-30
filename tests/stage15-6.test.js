/**
 * stage15-6.test.js — VERSION 1.0 (30.09.2026)
 * Этап 15.6: резервная копия таблицы на Диск (backupNow / weeklyBackup) и «Мой месяц» (admin.stats).
 * Запуск: node tests/stage15-6.test.js
 */
const crypto = require('crypto');
const { createGas } = require('./gas-emulator');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('OK   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 500) : '')); }
}

const g = createGas(); const c = g.ctx;
c.setup(); c.setupSecrets('1234');
const call = (action, payload, token) => c.Api_dispatch({ action, payload: payload || {}, auth: { token: token || null }, request_id: crypto.randomUUID() });
const T = call('admin.login', { pin: '1234' }).data.token;

// ---------- бэкап
const live = () => g.log.drive.files.filter((f) => f.folderId && !f.trashed);
const m1 = c.backupNow();
ok('первая копия: папка создана, копия в ней', g.log.drive.folders.length === 1 && live().length === 1 && /^MassageOnline backup \d{4}-\d\d-\d\d \d\d-\d\d$/.test(live()[0].name), m1);
ok('id папки запомнен', g.props.BACKUP_FOLDER_ID === g.log.drive.folders[0].id);
c.CFG_set('backup_keep', '3');
// имена по дате: подделываем старые копии, чтобы проверить ротацию
const folderId = g.props.BACKUP_FOLDER_ID;
['2026-01-04 04-00', '2026-01-11 04-00', '2026-01-18 04-00'].forEach((d) => {
  const f = g.log.drive.files[0].makeCopy('MassageOnline backup ' + d, { getId: () => folderId });
});
const foreign = g.log.drive.files[0].makeCopy('мой файл', { getId: () => folderId });
c.backupNow();
const names = live().map((f) => f.name).sort();
ok('хранится 3 последних копии, старые в корзине', live().filter((f) => f.name.startsWith('MassageOnline backup')).length === 3 &&
  g.log.drive.files.filter((f) => f.trashed).map((f) => f.name).join('|') === 'MassageOnline backup 2026-01-04 04-00|MassageOnline backup 2026-01-11 04-00', names);
ok('чужие файлы в папке не трогаются', !foreign.trashed);
g.log.drive.folders[0].setTrashed(true);
c.backupNow();
ok('папку удалили — создаётся новая', g.log.drive.folders.length === 2 && g.props.BACKUP_FOLDER_ID === g.log.drive.folders[1].id);

// weeklyBackup: ошибка → разработчику и в журнал
c.CFG_set('dev_tg_chat_id', '2002');
g.props.TELEGRAM_CLIENT_BOT_TOKEN = '1:x';
const realGet = c.DriveApp.getFileById;
c.DriveApp.getFileById = () => { throw new Error('Нет доступа к Диску'); };
g.log.fetch.length = 0;
let threw = false; try { c.weeklyBackup(); } catch (e) { threw = true; }
ok('weeklyBackup: ошибка — разработчику, триггер видит падение', threw && g.log.fetch.some((f) => /Резервная копия не создана: Нет доступа/.test(f[1].payload)));
ok('weeklyBackup: ошибка в audit', c.Sheet_readAll('audit').some((a) => a.action === 'weeklyBackup' && a.status === 'ERROR'));
c.DriveApp.getFileById = realGet;
c.weeklyBackup();
ok('weeklyBackup: успех в audit', c.Sheet_readAll('audit').some((a) => a.action === 'weeklyBackup' && a.status === 'OK'));
g.log.triggers.length = 0;
ok('installTriggers ставит weeklyBackup', /weeklyBackup вс 04:00/.test(c.installTriggers()) && g.log.triggers.includes('weeklyBackup'));

// ---------- «Мой месяц»: данные в прошлом месяце, чтобы не зависеть от сегодняшней даты
const ym = c.dateOf(new Date()).slice(0, 7);
const prevYm = c.AdminStats_shift_(ym, -1);
ok('сдвиг месяца через год', c.AdminStats_shift_('2026-01', -1) === '2025-12' && c.AdminStats_shift_('2025-12', 1) === '2026-01');
const cl = (name, phone) => { const r = { client_id: crypto.randomUUID(), phone, name, identity_provider: 'admin', is_blocked: 'FALSE', first_seen_at: c.nowIso() }; c.Sheet_append('clients', r); return r.client_id; };
const anna = cl('Анна', '+79160000001'), olga = cl('Ольга', '+79160000002'), vera = cl('Вера', '+79160000003');
const put = (clientId, ds, hm, min, status) => c.Bookings_insert({
  booking_id: crypto.randomUUID(), request_id: crypto.randomUUID(), client_id: clientId, service_id: 'svc_massage_60',
  start_at: c.iso(c.toDate(ds, hm)), end_at: c.iso(c.addMin(c.toDate(ds, hm), min)), status, comment: '', source: 'admin',
  calendar_sync_status: 'synced', gcal_event_id: '', created_at: c.nowIso() });
const pd = (n) => prevYm + '-' + String(n).padStart(2, '0');
// Анна: 3 визита (один — ещё confirmed, но прошёл), Ольга: 1 визит + неявка, Вера: отмена
put(anna, pd(3), '10:00', 60, 'completed');
put(anna, pd(10), '10:00', 90, 'completed');
put(anna, pd(10), '12:00', 60, 'confirmed');     // прошла, ночная отметка ещё не случилась
put(olga, pd(10), '15:00', 60, 'completed');
put(olga, pd(17), '15:00', 60, 'no_show');
put(vera, pd(20), '15:00', 60, 'cancelled_by_client');
// Ольга приходила и за два месяца до — значит, в прошлом месяце она не новая (из архива)
c.Sheet_append('bookings_archive', { booking_id: 'arch1', client_id: olga, start_at: c.iso(c.toDate(c.AdminStats_shift_(ym, -2) + '-05', '10:00')),
  end_at: c.iso(c.toDate(c.AdminStats_shift_(ym, -2) + '-05', '11:00')), status: 'completed' });

const st = call('admin.stats', { month: prevYm }, T);
ok('stats открывается', st.ok, st);
const s = st.data;
ok('визиты: 4 (прошедшая confirmed считается), часы: 4,5', s.visits === 4 && s.minutes === 270, s);
ok('неявки 1, отмены 1', s.no_show === 1 && s.cancelled === 1, s);
ok('клиентов 2, новых 1 (Ольга приходила раньше)', s.clients === 2 && s.new_clients === 1, s);
ok('постоянные: Анна (3); Ольга с одним визитом не попадает', s.top_clients.length === 1 && s.top_clients[0].name === 'Анна' && s.top_clients[0].visits === 3, s.top_clients);
ok('лучший день — десятое: 3 клиента, 3,5 ч', s.best_day && s.best_day.date === pd(10) && s.best_day.visits === 3 && s.best_day.minutes === 210, s.best_day);
const wd10 = c.weekdayOf(pd(10)) - 1;
ok('по дням недели: десятое — 3', s.by_weekday[wd10] >= 3 && s.by_weekday.reduce((a, b) => a + b, 0) === 4, s.by_weekday);
ok('сравнение с месяцем раньше: там 1 визит (архив)', s.prev_visits === 1, s.prev_visits);
ok('прошлый месяц — не текущий', s.is_current === false && s.month === prevYm);
const cur = call('admin.stats', {}, T);
ok('без месяца — текущий', cur.ok && cur.data.month === ym && cur.data.is_current === true && cur.data.prev_visits === 4, cur.data);
ok('мусор в месяце — текущий', call('admin.stats', { month: '2026-13' }, T).data.month === ym);
ok('без токена — UNAUTHORIZED', call('admin.stats', { month: prevYm }).error.code === 'UNAUTHORIZED');

ok('runSelfTests', /ВСЕ ТЕСТЫ ПРОЙДЕНЫ/.test(String(c.runSelfTests())));
console.log('\nИтог: ' + pass + ' OK, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
