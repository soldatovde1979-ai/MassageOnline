/**
 * web-client.e2e.js — VERSION 1.0 (29.09.2026)
 * Сквозной тест клиентской витрины web/: настоящие index.html + config.js + demo_v1.js + app_v1.js в jsdom.
 *   A. Боевой режим: fetch подменён на doPost эмулятора GAS — работает настоящий серверный код src/.
 *   B. Демо-режим: demo_v1.js, отмена → «Вернуть запись», перенос, Telegram Mini App.
 *   C. Контроль версий: мажоры index.html ↔ app_v1.js ↔ config.js ↔ demo_v1.js, ссылки на файлы, sw.js, манифест.
 * Прогон идёт в четырёх часовых поясах устройства: время на витрине обязано быть временем мастера.
 * Запуск: node tests/web-client.e2e.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');
const { createGas } = require('./gas-emulator');

const ZONES = ['Europe/Moscow', 'UTC', 'America/Los_Angeles', 'Asia/Vladivostok'];

// ---------------------------------------------------------------- родитель: прогон по поясам
if (!process.env.MB_WEB_TZ_CHILD) {
  let pass = 0, fail = 0;
  ZONES.forEach((tz) => {
    let out;
    try {
      out = execFileSync(process.execPath, [__filename], { encoding: 'utf8', env: Object.assign({}, process.env, { TZ: tz, MB_WEB_TZ_CHILD: '1' }), timeout: 180000 });
    } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
    const m = out.match(/Пояс устройства .*: (\d+) OK, (\d+) FAIL/);
    const p = m ? +m[1] : 0, f = m ? +m[2] : 1;
    pass += p; fail += f;
    console.log('--- ' + tz + ': ' + p + ' OK, ' + f + ' FAIL');
    out.split('\n').filter((l) => /^FAIL|CRASH|Error/.test(l) || (tz === ZONES[0] && /^OK/.test(l))).forEach((l) => console.log('   ' + l));
  });
  console.log('\nИтог: ' + pass + ' OK, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
}

// ---------------------------------------------------------------- ребёнок: сам тест
let pass = 0, fail = 0;
const ok = (n, v, x) => {
  if (v) { pass++; console.log('OK   ' + n); } else { fail++; console.log('FAIL ' + n + (x !== undefined ? ' :: ' + String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 300) : '')); }
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 15 : ms));
async function until(fn, ms) {
  const end = Date.now() + (ms || 3000);
  while (Date.now() < end) { try { if (fn()) return true; } catch (e) { /* ещё не готово */ } await tick(10); }
  return false;
}

const WEB = path.join(__dirname, '..', 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

/** index.html со встроенными локальными скриптами (jsdom не грузит файлы сам). */
function buildHtml(o) {
  let html = read('index.html').replace(/<script src="([^":]+)"><\/script>/g, (m, f) => {
    let code = read(f);
    if (f === 'config.js' && o.apiUrl) code += '\nwindow.MB_CONFIG.API_URL = ' + JSON.stringify(o.apiUrl) + ';';
    return '<script>' + code + '\n</script>';
  });
  if (o.major) html = html.replace('name="mb-app-major" content="1"', 'name="mb-app-major" content="' + o.major + '"');
  return html;
}

function boot(o) {
  o = o || {};
  const opened = [];
  const dom = new JSDOM(buildHtml(o), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.github.io/massage/',
    beforeParse(w) {
      Object.keys(o.storage || {}).forEach((k) => w.localStorage.setItem(k, o.storage[k]));
      if (o.fetch) w.fetch = o.fetch;
      if (o.tg) w.Telegram = { WebApp: o.tg };
      w.MB_DEMO_LATENCY = 0;
      w.scrollTo = () => { };
      w.open = (u) => { opened.push(u); };
    }
  });
  const w = dom.window;
  w.opened = opened;
  return w;
}

const $ = (w, s) => w.document.querySelector(s);
const $$ = (w, s) => Array.from(w.document.querySelectorAll(s));
const text = (w, s) => { const el = $(w, s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; };
const slotBtn = (w, hm) => $$(w, '.slot button').find((b) => (b.getAttribute('aria-label') || '').indexOf(hm) === 0);
const act = (w, name, attr) => $$(w, '[data-act="' + name + '"]').find((b) => !attr || Object.keys(attr).every((k) => b.getAttribute('data-' + k) === attr[k]));
const dump = (w) => ({ view: text(w, '#view').slice(0, 200), toast: text(w, '#toast-host') });
function fill(w, name, value) {
  const el = $(w, '#book-form [name="' + name + '"]');
  el.value = value;
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
}
const submit = (w) => $(w, '#book-submit').click();
const store = (w, k) => JSON.parse(w.localStorage.getItem(k) || 'null');
const storageOf = (w) => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; };

// ================================================================ C. контроль версий (без DOM)
(function versions() {
  const html = read('index.html');
  const appJs = read('app_v1.js');
  const htmlMajor = +(html.match(/name="mb-app-major" content="(\d+)"/) || [])[1];
  const appMajor = +(appJs.match(/var APP_MAJOR = (\d+);/) || [])[1];
  const sandbox = { window: {} };
  require('vm').runInNewContext(read('config.js'), sandbox);
  ok('C: мажор index.html = app_v1.js = config.js = 1', htmlMajor === 1 && appMajor === 1 && sandbox.window.MB_CONFIG.APP_MAJOR === 1, [htmlMajor, appMajor, sandbox.window.MB_CONFIG.APP_MAJOR]);
  const refs = [];
  html.replace(/(?:src|href)="([^":#]+)"/g, (m, f) => refs.push(f));
  const missing = refs.filter((f) => !fs.existsSync(path.join(WEB, f)));
  ok('C: все локальные ссылки index.html существуют', refs.length >= 8 && !missing.length, missing);
  const vers = refs.map((f) => (f.match(/_v(\d+)\.\w+$/) || [])[1]).filter(Boolean);
  ok('C: версионные файлы в index.html — того же мажора', vers.length >= 3 && vers.every((v) => +v === htmlMajor), vers);
  ok('C: demo_v1.js — мажор 1 внутри', /var DEMO_MAJOR = 1;/.test(read('demo_v1.js')));
  const shell = (read('sw.js').match(/var SHELL = \[([\s\S]*?)\];/) || [])[1] || '';
  const shellFiles = shell.match(/'([^']+)'/g).map((s) => s.slice(1, -1)).filter((f) => f !== './');
  ok('C: sw.js кэширует только существующие файлы и все скрипты index.html', shellFiles.every((f) => fs.existsSync(path.join(WEB, f))) &&
    refs.filter((f) => /\.(js|css)$/.test(f)).every((f) => shellFiles.indexOf(f) >= 0), shellFiles);
  const man = JSON.parse(read('manifest.webmanifest'));
  ok('C: иконки манифеста на месте, есть maskable 512', man.icons.every((i) => fs.existsSync(path.join(WEB, i.src))) && man.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
})();

(async () => {
  // ================================================================ A. боевой режим против эмулятора GAS
  const g = createGas();
  const c = g.ctx;
  c.setup(); c.setupSecrets('1234'); c.setupPortal();
  c.CFG_set('web_app_url', 'https://script.google.com/macros/s/TEST/exec');
  c.CFG_set('lead_time_min', '0');
  c.CFG_set('master_name', 'Мария');
  c.CFG_set('studio_address', 'ул. Тестовая, 5');
  c.CFG_set('studio_after_booking', 'Код домофона 45К');
  c.Schedule_set([1, 2, 3, 4, 5, 6, 7].map((wd) => ({ weekday: wd, is_working: true, start_time: '10:00', end_time: '20:00', note: '' })));
  c.CFG_invalidate();
  const svc = c.Services_list(true)[0].service_id;
  const call = (action, payload, token) => c.Api_dispatch({ action, payload: payload || {}, auth: { token: token || null }, request_id: crypto.randomUUID() });

  let d = new Date(Date.now() + 7 * 86400000);
  while (c.weekdayOf(c.dateOf(d)) !== 1) d = new Date(d.getTime() + 86400000);
  const day = c.dateOf(d);
  const day2 = c.dateOf(new Date(d.getTime() + 86400000));
  const at = (hm, k) => c.iso(c.toDate(k || day, hm));
  // чужая запись 12:00–13:00 — даёт разрыв в ленте
  call('booking.create', { service_id: svc, start_at: at('12:00'), slots_count: 2, client: { name: 'Ольга', phone: '+79035550000' } });

  const calls = [];
  const serverFetch = (url, o) => {
    const body = JSON.parse(o.body);
    calls.push(body);
    let out;
    try { out = c.doPost({ parameter: {}, postData: { contents: o.body } }).getContent(); } catch (e) { return Promise.reject(e); }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(out)) });
  };

  let w = boot({ apiUrl: 'https://script.google.com/macros/s/TEST/exec', fetch: serverFetch });
  await w.MB_APP.ready;
  const S = w.MB_APP.state;
  ok('A: витрина загрузилась, три вкладки', $$(w, '.tab').length === 3 && !$(w, '.fatal'), dump(w));
  ok('A: public.info — мастер и правила с сервера', S.info && S.info.master_name === 'Мария' && S.info.min_slots === 2 && S.info.max_slots === 8);
  ok('A: лента дат на весь горизонт', $$(w, '.date').length === S.info.horizon_days + 1, $$(w, '.date').length);
  ok('A: запросы идут через doPost, диапазон ≤ 15 дней', calls.filter((x) => x.action === 'availability.get').length >= 2 &&
    calls.filter((x) => x.action === 'availability.get').every((x) => (Date.parse(x.payload.date_to) - Date.parse(x.payload.date_from)) / 86400000 <= 14));
  ok('A: демо-плашки нет в боевом режиме', !$(w, '.demo-note'));

  act(w, 'date', { date: day }).click(); await tick();
  ok('A: выбран нужный день', act(w, 'date', { date: day }).getAttribute('aria-pressed') === 'true');
  ok('A: лента времени по 30 минут, чужая запись — разрыв «занято»', !!slotBtn(w, '10:00') && !!slotBtn(w, '11:30') && !slotBtn(w, '12:00') && !slotBtn(w, '12:30') && !!slotBtn(w, '13:00') && $$(w, '.gap').length === 1,
    $$(w, '.slot .t').map((x) => x.textContent).join(' '));

  slotBtn(w, '10:00').click(); await tick();
  ok('A: тап по началу — сразу минимум 1 ч (10:00–11:00)', S.sel.length === 2 && /10:00–11:00/.test(text(w, '.bar')), text(w, '.bar'));
  slotBtn(w, '13:00').click(); await tick();
  ok('A: слот через разрыв — ошибка, выбор не изменился', /занятое время/.test(text(w, '#toast-host')) && S.sel.length === 2, dump(w));
  slotBtn(w, '11:30').click(); await tick();
  ok('A: тап по последнему слоту — 10:00–12:00, 2 ч', S.sel.length === 4 && /10:00–12:00/.test(text(w, '.bar')) && /2 ч/.test(text(w, '.bar')), text(w, '.bar'));

  act(w, 'continue').click(); await tick();
  ok('A: лист записи с полями имени и телефона', !!$(w, '#book-form [name="name"]') && !!$(w, '#book-form [name="phone"]'));
  submit(w); await tick();
  ok('A: пустая форма — две ошибки, запрос не ушёл', $$(w, '.field.error').length === 2 && !calls.some((x) => x.action === 'booking.create'));
  fill(w, 'name', 'Анна Петрова'); fill(w, 'phone', '8 916 123-45-67'); fill(w, 'comment', 'шея и плечи');
  await tick(450);
  ok('A: черновик формы сохраняется на устройстве (Т-11)', (store(w, 'mb_draft_v1') || {}).name === 'Анна Петрова');
  submit(w);
  await until(() => S.view === 'done');
  ok('A: экран «Запись подтверждена» 10:00–12:00', /Запись подтверждена/.test(text(w, '.done')) && text(w, '.done .when') === '10:00–12:00', dump(w));
  const mine = c.Bookings_all(true).filter((b) => b.status === 'confirmed' && b.comment === 'шея и плечи');
  ok('A: на сервере запись 10:00–12:00, источник web', mine.length === 1 && mine[0].start_at === at('10:00') && mine[0].end_at === at('12:00') && mine[0].source === 'web', mine);
  const anna = c.Clients_all().find((x) => x.phone === '+79161234567');
  ok('A: клиент создан, телефон нормализован', !!anna && anna.name === 'Анна Петрова');
  ok('A: имя, телефон и ссылка управления сохранены на устройстве, черновик очищен',
    (store(w, 'mb_client_v1') || {}).phone === '+79161234567' && (store(w, 'mb_bookings_v1') || []).length === 1 && !!store(w, 'mb_bookings_v1')[0].token && !store(w, 'mb_draft_v1'));
  await until(() => /Код домофона 45К/.test(text(w, '.done')));
  ok('A: «Как попасть» — только после записи (studio_after_booking)', /Код домофона 45К/.test(text(w, '.done')) && /ул\. Тестовая, 5/.test(text(w, '.done')));
  act(w, 'gcal').click();
  ok('A: «В Google Календарь» — ссылка с точным временем', w.opened.length === 1 && w.opened[0].indexOf('calendar.google.com') > 0 &&
    w.opened[0].indexOf(c.Utilities.formatDate(c.parseIsoStrict(at('10:00')), 'UTC', "yyyyMMdd'T'HHmmss") + 'Z') > 0, w.opened[0]);
  act(w, 'tab', { tab: 'book' }).click(); await tick();
  await until(() => S.chunks['30|0'] === 'done');
  act(w, 'date', { date: day }).click(); await tick();
  ok('A: после записи своё время исчезло из ленты', !slotBtn(w, '10:00') && !slotBtn(w, '11:30'), $$(w, '.slot .t').map((x) => x.textContent).join(' '));

  // «Мои записи»
  act(w, 'tab', { tab: 'mine' }).click();
  await until(() => $$(w, '.card').length === 1 && !!act(w, 'resched'));
  ok('A: «Мои записи» — карточка с переносом и отменой, бейдж 1', /10:00–12:00/.test(text(w, '.card')) && !!act(w, 'cancel') && text(w, '.tab .badge') === '1', dump(w));

  // перенос на следующий день 15:00 — длительность сохраняется
  act(w, 'resched').click(); await tick();
  ok('A: режим переноса', /Перенос записи/.test(text(w, '.hero')) && S.mode === 'resched');
  act(w, 'date', { date: day2 }).click(); await tick();
  await until(() => !!slotBtn(w, '15:00'));
  const gapsBefore = $$(w, '.gap').length;
  ok('A: при переносе лента та же — получасовая, без ложных «занято»', gapsBefore === 0 && !!slotBtn(w, '15:30'), $$(w, '.slot .t').map((x) => x.textContent).join(' '));
  slotBtn(w, '15:00').click(); await tick();
  ok('A: тап при переносе выделяет всю длительность 15:00–17:00', S.sel.length === 4 && /15:00–17:00/.test(text(w, '.bar')), dump(w));
  act(w, 'resched-confirm').click();
  await until(() => S.tab === 'mine' && S.mode === 'book');
  const moved = c.Bookings_all(true).find((b) => b.booking_id === mine[0].booking_id);
  ok('A: на сервере перенесено на 15:00–17:00', moved.start_at === at('15:00', day2) && moved.end_at === at('17:00', day2), moved);
  await until(() => /15:00–17:00/.test(text(w, '.card')));
  ok('A: карточка обновилась, ссылка управления — новой версии', /15:00–17:00/.test(text(w, '.card')) &&
    store(w, 'mb_bookings_v1')[0].token === c.Security_buildManageToken(moved), store(w, 'mb_bookings_v1'));
  act(w, 'tab', { tab: 'book' }).click(); await tick();
  act(w, 'date', { date: day }).click();
  await until(() => !!slotBtn(w, '10:00'));
  ok('A: старое время после переноса снова свободно в ленте', !!slotBtn(w, '10:00'));

  // отмена; возврата нет, пока нет 54_Restore.gs
  act(w, 'tab', { tab: 'mine' }).click(); await until(() => !!act(w, 'cancel'));
  act(w, 'cancel').click(); await tick();
  ok('A: подтверждение отмены с датой и временем', /Отменить запись\?/.test(text(w, '#overlay')) && /15:00–17:00/.test(text(w, '#overlay')));
  act(w, 'cancel-yes').click();
  await until(() => c.Bookings_get(mine[0].booking_id).status === 'cancelled_by_client');
  await until(() => /Отменена/.test(text(w, '#view')) || /Предстоящих записей нет/.test(text(w, '#view')));
  ok('A: отмена дошла до сервера, без 54_Restore.gs кнопки «Вернуть» нет',
    c.Bookings_get(mine[0].booking_id).status === 'cancelled_by_client' && !act(w, 'restore') && S.info.restore_window_min === 0, dump(w));

  // возврат: подключаем серверный booking.restore (заглушка этапа 14) — проверяем связку Portal ↔ витрина
  c.Api_bookingRestore = function (req) {
    const b = c.Security_verifyManageToken(req.auth && req.auth.token);
    if (b.status !== 'cancelled_by_client') throw c.apiError('NOT_FOUND', 'Нечего возвращать');
    c.Bookings_update(b.booking_id, { status: 'confirmed' });
    return { ok: true, data: c.Bookings_toPublic(c.Bookings_get(b.booking_id)) };
  };
  const saved = storageOf(w);
  w.close();
  w = boot({ apiUrl: 'https://script.google.com/macros/s/TEST/exec', fetch: serverFetch, storage: saved });
  await w.MB_APP.ready;
  const S2 = w.MB_APP.state;
  ok('A: повторный визит — приветствие по имени (Т-8)', /Здравствуйте, Анна/.test(text(w, '.hero h1')), text(w, '.hero h1'));
  act(w, 'tab', { tab: 'mine' }).click();
  await until(() => !!act(w, 'restore'));
  ok('A: с booking.restore — «Вернуть запись», осталось ~30 мин', !!act(w, 'restore') && /ещё (29|30) мин/.test(text(w, '.card')), dump(w));
  act(w, 'restore').click();
  await until(() => c.Bookings_get(mine[0].booking_id).status === 'confirmed' && !!act(w, 'cancel'));
  ok('A: запись снова в силе на сервере и в карточке', c.Bookings_get(mine[0].booking_id).status === 'confirmed' && !!act(w, 'resched'), dump(w));

  // «как в прошлый раз»: первый тап сразу берёт 2 часа; известный клиент — без полей ввода
  act(w, 'tab', { tab: 'book' }).click(); await tick();
  act(w, 'date', { date: day }).click();
  await until(() => !!slotBtn(w, '16:00'));
  ok('A: подсказка «как в прошлый раз — 2 ч»', /Как в прошлый раз — 2 ч/.test(text(w, '#hint')), text(w, '#hint'));
  slotBtn(w, '16:00').click(); await tick();
  ok('A: «как в прошлый раз» — первый тап выделяет 16:00–18:00', S2.sel.length === 4 && /16:00–18:00/.test(text(w, '.bar')), text(w, '.bar'));
  act(w, 'continue').click(); await tick();
  ok('A: известный клиент — имя и телефон не спрашиваются', !$(w, '#book-form [name="phone"]') && /Анна Петрова/.test(text(w, '.known')));

  // гонка за слот: кто-то занял 16:00, пока лист открыт
  call('booking.create', { service_id: svc, start_at: at('16:30'), slots_count: 2, client: { name: 'Вера', phone: '+79037770000' } });
  submit(w);
  await until(() => /только что заняли/.test(text(w, '#toast-host')));
  ok('A: SLOT_TAKEN — понятное сообщение, выбор сброшен', /только что заняли/.test(text(w, '#toast-host')) && S2.sel.length === 0 && !$(w, '#book-form'), dump(w));
  await until(() => !slotBtn(w, '16:30'));
  ok('A: день перезагружен — занятое время исчезло', !slotBtn(w, '16:30') && !slotBtn(w, '17:00') && !!slotBtn(w, '16:00'), $$(w, '.slot .t').map((x) => x.textContent).join(' '));

  // идемпотентность: повтор с тем же request_id при сетевой ошибке не создаёт дубль
  slotBtn(w, '18:00').click(); await tick();
  let dropOnce = true;
  const flakyFetch = (url, o) => {
    const res = serverFetch(url, o);
    if (JSON.parse(o.body).action === 'booking.create' && dropOnce) { dropOnce = false; return res.then(() => Promise.reject(new TypeError('Failed to fetch'))); }
    return res;
  };
  w.fetch = flakyFetch;
  act(w, 'continue').click(); await tick();
  submit(w);
  await until(() => /Нет связи/.test(text(w, '#overlay')));
  ok('A: обрыв связи после записи — «нажмите ещё раз, дубля не будет»', /дубля не будет/.test(text(w, '#overlay')), dump(w));
  submit(w);
  await until(() => S2.view === 'done');
  const at18 = c.Bookings_all(true).filter((b) => b.start_at === at('18:00') && b.status === 'confirmed');
  ok('A: повтор с тем же request_id — одна запись, не две', at18.length === 1, at18.length);

  // Т-10: перерисовка ленты дат не отматывает её в начало. jsdom без вёрстки — задаём геометрию как в телефоне:
  // дата 56 px + зазор 8, отступ 20, видимая ширина 360.
  act(w, 'book-more').click(); await tick();
  const P = w.HTMLElement.prototype;
  const idx = (el) => Array.prototype.indexOf.call(el.parentNode.children, el);
  Object.defineProperty(P, 'offsetLeft', { configurable: true, get() { return this.classList.contains('date') ? 20 + idx(this) * 64 : 0; } });
  Object.defineProperty(P, 'offsetWidth', { configurable: true, get() { return this.classList.contains('date') ? 56 : 0; } });
  Object.defineProperty(P, 'clientWidth', { configurable: true, get() { return this.id === 'dates' ? 360 : 0; } });
  const strip = $(w, '#dates');
  strip.scrollLeft = 480;                                   // видны даты с 8-й по 11-ю
  act(w, 'date', { date: S2.order[9] }).click(); await tick();
  const firstSlot = $$(w, '.slot button')[0];
  if (firstSlot) firstSlot.click();
  await tick();
  ok('A: выбор видимой даты и тап по времени не отматывают ленту дат (Т-10)', $(w, '#dates').scrollLeft === 480, $(w, '#dates').scrollLeft);
  act(w, 'date', { date: S2.order[25] }).click(); await tick();
  ok('A: дата за краем экрана — лента докручивается к ней', $(w, '#dates').scrollLeft === 20 + 25 * 64 - 20, $(w, '#dates').scrollLeft);
  w.close();

  // несовпадение мажоров — понятная ошибка вместо поломки
  w = boot({ apiUrl: 'https://script.google.com/macros/s/TEST/exec', fetch: serverFetch, major: '2' });
  await w.MB_APP.ready;
  ok('A: index.html другого мажора — экран «обновите файлы сайта»', /Обновите файлы сайта целиком/.test(text(w, '.fatal')), text(w, '#app'));
  w.close();

  // ================================================================ B. демо-режим
  w = boot({});
  await w.MB_APP.ready;
  const D = w.MB_APP.state;
  ok('B: демо запускается без сервера, есть плашка «Демо-режим»', !!$(w, '.demo-note') && D.info && D.info.restore_window_min === 30, dump(w));
  // первый день и начало, где помещается час
  let pick = null;
  D.order.some((k) => {
    const sl = D.avail['30|' + k] || [];
    // не ближе 6 ч: иначе отмена уже закрыта дедлайном (4 ч) — это правильное поведение, но не то, что проверяем
    for (let i = 0; i + 1 < sl.length; i++) {
      if (sl[i].end === sl[i + 1].start && Date.parse(sl[i].start) - Date.now() > 6 * 3600000) { pick = { k, hm: sl[i].start.slice(11, 16) }; return true; }
    }
    return false;
  });
  ok('B: в демо есть свободные окна', !!pick);
  act(w, 'date', { date: pick.k }).click(); await tick();
  slotBtn(w, pick.hm).click(); await tick();
  act(w, 'continue').click(); await tick();
  fill(w, 'name', 'Катя'); fill(w, 'phone', '+7 999 111-22-33');
  submit(w);
  await until(() => D.view === 'done');
  ok('B: запись в демо подтверждена', /Запись подтверждена/.test(text(w, '.done')), dump(w));
  act(w, 'tab', { tab: 'mine' }).click();
  await until(() => !!act(w, 'cancel'));
  act(w, 'cancel').click(); await tick();
  ok('B: при отмене обещают 30 минут на возврат', /в течение 30 мин/.test(text(w, '#overlay')));
  act(w, 'cancel-yes').click();
  await until(() => !!act(w, 'restore'));
  ok('B: после отмены — «Вернуть запись», ещё 30 мин', !!act(w, 'restore') && /ещё (29|30) мин/.test(text(w, '.card')), dump(w));
  act(w, 'restore').click();
  await until(() => !!act(w, 'resched'));
  ok('B: запись возвращена', !!act(w, 'resched') && !act(w, 'restore'), dump(w));
  act(w, 'resched').click(); await tick();
  let target = null;
  const need = D.resched.slots;
  D.order.some((k) => {
    if (k === pick.k) return false;
    const sl = D.avail['30|' + k] || [];
    for (let i = 0; i + need - 1 < sl.length; i++) {
      let run = true;
      for (let j = i + 1; j < i + need; j++) if (sl[j - 1].end !== sl[j].start) run = false;
      if (run) { target = { k, hm: sl[i].start.slice(11, 16) }; return true; }
    }
    return false;
  });
  act(w, 'date', { date: target.k }).click(); await tick();
  slotBtn(w, target.hm).click(); await tick();
  act(w, 'resched-confirm').click();
  await until(() => D.tab === 'mine' && D.mode === 'book');
  await until(() => $$(w, '.card').length === 1 && D.bookings[0].start_at.slice(0, 10) === target.k);
  ok('B: перенос в демо', D.bookings.length === 1 && D.bookings[0].start_at.slice(0, 10) === target.k && D.bookings[0].start_at.slice(11, 16) === target.hm, D.bookings);
  w.close();

  // Telegram Mini App поверх демо
  const tgLog = [];
  const tgStub = {
    initData: 'query_id=AAE&user=%7B%22id%22%3A1%2C%22first_name%22%3A%22%D0%9E%D0%BB%D1%8F%22%7D&auth_date=1&hash=x',
    initDataUnsafe: { user: { id: 1, first_name: 'Оля' } },
    colorScheme: 'dark',
    ready: () => tgLog.push('ready'), expand: () => tgLog.push('expand'),
    onEvent: () => { }, openLink: (u) => tgLog.push('link:' + u),
    HapticFeedback: { selectionChanged: () => tgLog.push('h:select'), notificationOccurred: (k) => tgLog.push('h:' + k) },
    BackButton: { show: () => tgLog.push('back:show'), hide: () => tgLog.push('back:hide'), onClick: () => { } }
  };
  w = boot({ tg: tgStub });
  await w.MB_APP.ready;
  const T = w.MB_APP.state;
  ok('B: Telegram — ready/expand, тёмная тема, имя из Telegram', tgLog.indexOf('ready') >= 0 && tgLog.indexOf('expand') >= 0 &&
    w.document.documentElement.getAttribute('data-theme') === 'dark' && /Здравствуйте, Оля/.test(text(w, '.hero h1')), [tgLog, text(w, '.hero h1')]);
  act(w, 'date', { date: pick.k }).click(); await tick();
  const free = (T.avail['30|' + pick.k] || []);
  let i0 = -1;
  for (let i = 0; i + 1 < free.length; i++) if (free[i].end === free[i + 1].start) { i0 = i; break; }
  slotBtn(w, free[i0].start.slice(11, 16)).click(); await tick();
  act(w, 'continue').click(); await tick();
  ok('B: Telegram — имя подставлено, кнопка «Назад» показана', $(w, '#book-form [name="name"]').value === 'Оля' && tgLog.indexOf('back:show') >= 0);
  fill(w, 'phone', '+79990001122');
  submit(w);
  await until(() => T.view === 'done');
  const demoState = JSON.parse(w.localStorage.getItem('mb_demo_v1'));
  ok('B: Telegram — запись с source=telegram, вибрация успеха', demoState.bookings.some((b) => b.source === 'telegram') && tgLog.indexOf('h:success') >= 0, tgLog);
  w.close();

  console.log('\nПояс устройства ' + process.env.TZ + ': ' + pass + ' OK, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack)); console.log('\nПояс устройства ' + process.env.TZ + ': ' + pass + ' OK, ' + (fail + 1) + ' FAIL'); process.exit(1); });
