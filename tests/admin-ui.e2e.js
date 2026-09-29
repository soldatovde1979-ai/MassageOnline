/** Сквозной тест админки: настоящий admin.html + admin_js.html в jsdom, сервер — эмулятор GAS. VERSION 1.2 (+ карточка клиента 15.4; график с двумя окнами, отпуск, правила 15.5) */
const fs = require('fs'); const path = require('path');
const { JSDOM } = require('jsdom');
const { createGas } = require('./gas-emulator');
const g = createGas(); const c = g.ctx; c.setup(); c.setupSecrets('1234');
const UI = path.join(__dirname, '..', 'src', 'ui');
const inc = (n) => fs.readFileSync(path.join(UI, n + '.html'), 'utf8');
const html = inc('admin').replace(/<\?!= include\('(\w+)'\) \?>/g, (m, n) => inc(n));
let pass = 0, fail = 0;
const ok = (n, v, x) => { if (v) { pass++; console.log('OK   ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + String(x).slice(0, 300) : '')); } };
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://script.google.com/macros/s/X/exec?r=admin' });
const w = dom.window;
w.confirm = () => true;
w.google = { script: { run: (function mk(s, f) { return {
  withSuccessHandler: (fn) => mk(fn, f), withFailureHandler: (fn) => mk(s, fn),
  apiCall: (json) => setTimeout(() => { try { s(c.apiCall(json)); } catch (e) { f(e); } }, 0) }; })() } };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 30));
const $ = (id) => w.document.getElementById(id);
const setVal = (id, v) => { $(id).value = v; $(id).dispatchEvent(new w.Event('input')); };

(async () => {
  w.dispatchEvent(new w.Event('load')); await tick();
  $('pin').value = '1234'; $('doLogin').click(); await tick(80);
  ok('вход по PIN показывает приложение', !$('app').classList.contains('hide'));
  // дата: следующий понедельник через 7+ дней
  let d = new Date(Date.now() + 7 * 86400000); while (c.weekdayOf(c.dateOf(d)) !== 1) d = new Date(d.getTime() + 86400000);
  const day = c.dateOf(d);
  // заранее существующая клиентка для автоподсказки
  c.Api_dispatch({ action: 'booking.create', request_id: 'r0', payload: { service_id: 'svc_massage_60', start_at: c.iso(c.toDate(day, '10:00')), slots_count: 2, client: { name: 'Светлана', phone: '+79161112233' } } });

  $('newBk').click(); await tick();
  ok('кнопка «+ Запись» открывает форму', !$('sheet').classList.contains('hide') && !!$('fName'));
  setVal('fName', 'Свет'); await tick(400);
  ok('автоподсказка находит Светлану', !$('fSug').classList.contains('hide') && /Светлана/.test($('fSug').textContent), $('fSug').innerHTML);
  $('fSug').children[0].click(); await tick();
  ok('выбор подсказки прячет поле телефона', $('fPhone').classList.contains('hide') && /Светлана/.test($('fPicked').textContent));
  $('fDate').value = day; $('fTime').value = '14:00';
  $('fDur').children[2].click(); // 1,5 ч
  $('fSave').click(); await tick(120);
  const all = c.Bookings_all(true).filter((b) => b.source === 'admin');
  ok('запись создана на 14:00–15:30', all.length === 1 && all[0].start_at === c.iso(c.toDate(day, '14:00')) && all[0].end_at === c.iso(c.toDate(day, '15:30')), JSON.stringify(all));
  ok('форма закрылась, день перерисован', $('sheet').classList.contains('hide') && /Светлана/.test($('board').textContent));
  ok('клиент не задвоился', c.Clients_all().filter((x) => x.phone === '+79161112233').length === 1);

  // новая клиентка + предупреждение «вне графика» (confirm → true)
  $('newBk').click(); await tick();
  setVal('fName', 'Ника'); await tick(350);
  $('fPhone').value = '8 903 000-11-22'; $('fDate').value = day; $('fTime').value = '20:30';
  $('fSave').click(); await tick(200);
  ok('вне графика — после подтверждения записано', c.Bookings_all(true).some((b) => b.start_at === c.iso(c.toDate(day, '20:30'))));

  // тап по записи → лист действий → перенос
  const ev = [...w.document.querySelectorAll('.ev.booking')].find((n) => /Светлана/.test(n.textContent) && /14:00/.test(n.textContent));
  ok('запись видна в дне', !!ev);
  ev.click(); await tick();
  ok('лист действий: позвонить, Telegram, перенести', !!w.document.querySelector('a[href="tel:+79161112233"]') && !!$('aMove'));
  ok('будущую запись нельзя отметить', !$('aDone') && !$('aNo'));
  $('aMove').click(); await tick();
  $('fTime').value = '16:00'; $('fSave').click(); await tick(150);
  const mv = c.Bookings_all(true).find((b) => b.source === 'admin' && /Светлана/.test(c.Clients_get(b.client_id).name));
  ok('перенесено на 16:00, длительность 1,5 ч сохранена', mv.start_at === c.iso(c.toDate(day, '16:00')) && mv.end_at === c.iso(c.toDate(day, '17:30')), JSON.stringify(mv));

  // тап по свободной получасовке открывает форму с этим временем
  const line = [...w.document.querySelectorAll('.gline')].find((n) => n.dataset.t === '12:30');
  line.click(); await tick();
  ok('тап по 12:30 — форма с 12:30', $('fTime') && $('fTime').value === '12:30' && $('fDate').value === day);
  $('fClose').click();

  // этап 15.4: карточка клиента из листа записи, заметка, повторная запись из карточки
  const ev2 = [...w.document.querySelectorAll('.ev.booking')].find((n) => /Светлана/.test(n.textContent));
  ev2.click(); await tick();
  ok('в листе записи есть «Карточка»', !!$('aCard'));
  $('aCard').click(); await tick(80);
  ok('карточка: имя, счётчик визитов, история', /Светлана/.test($('sheetBody').textContent) && /визитов: 0/.test($('sheetBody').textContent) &&
    w.document.querySelectorAll('.hist > div').length === 2, $('sheetBody').textContent);
  $('cNotes').value = 'Шея, давление сильнее'; $('cSave').click(); await tick(120);
  const sv = c.Clients_findByPhone('+79161112233');
  ok('заметка сохранена в таблицу', sv.notes === 'Шея, давление сильнее', JSON.stringify(sv));
  ok('после сохранения — подтверждение', !$('cMsg').classList.contains('hide'));
  $('cClose').click(); await tick(60);
  const ev3 = [...w.document.querySelectorAll('.ev.booking')].find((n) => /Светлана/.test(n.textContent));
  ev3.click(); await tick();
  ok('заметка видна в листе записи', $('aNote') && /Шея/.test($('aNote').textContent));
  $('aCard').click(); await tick(80);
  $('cBook').click(); await tick();
  ok('«Записать» из карточки: клиент уже выбран', $('fPhone').classList.contains('hide') && /Светлана/.test($('fPicked').textContent));
  $('fDate').value = day; $('fTime').value = '18:00'; $('fSave').click(); await tick(150);
  ok('запись из карточки создана без дубля клиента', c.Bookings_all(true).some((b) => b.start_at === c.iso(c.toDate(day, '18:00')) && b.client_id === sv.client_id) &&
    c.Clients_all().filter((x) => x.phone === '+79161112233').length === 1);

  // кнопка «Клиенты»: поиск → карточка
  $('openClients').click(); await tick();
  setVal('clQ', 'ник'); await tick(400);
  const row = $('clList').querySelector('[data-id]');
  ok('поиск клиентов находит Нику', row && /Ника/.test(row.textContent), $('clList').innerHTML);
  row.click(); await tick(80);
  ok('из поиска открывается карточка', /Ника/.test($('sheetBody').textContent) && !!$('cNotes'));
  $('cClose').click();

  // этап 15.5: второе окно в дне через «График»
  $('openSched').click(); await tick(80);
  const q = (cls, wd) => w.document.querySelector('.' + cls + '[data-wd="' + wd + '"]');
  ok('график: второе окно скрыто', q('sw-s2', 3).closest('tr').style.display === 'none');
  q('sw-e', 3).value = '13:00';
  q('sw-add', 3).click();
  ok('«+ окно» показывает вторую строку', q('sw-s2', 3).closest('tr').style.display === '' && q('sw-s2', 3).value === '13:00');
  q('sw-s2', 3).value = '16:00'; q('sw-e2', 3).value = '20:00';
  $('saveSched').click(); await tick(120);
  const wed = c.Schedule_all().filter((r) => r.weekday === 3 && r.is_working).map((r) => r.start_time + '-' + r.end_time).sort();
  ok('в среду сохранено два окна', JSON.stringify(wed) === '["10:00-13:00","16:00-20:00"]', JSON.stringify(wed));
  $('openSched').click(); await tick(80);
  ok('при повторном открытии второе окно на месте', q('sw-s2', 3).value === '16:00' && q('sw-s2', 3).closest('tr').style.display === '');
  q('sw-del', 3).click(); $('saveSched').click(); await tick(120);
  ok('«×» убирает второе окно', c.Schedule_all().filter((r) => r.weekday === 3 && r.is_working).length === 1);

  // отпуск: закрыть вт–чт следующей недели после day
  const vFrom = c.dateOf(c.addDays(c.toDate(day, '12:00'), 8)), vTo = c.dateOf(c.addDays(c.toDate(day, '12:00'), 10));
  $('vFrom').value = vFrom; $('vTo').value = vTo; $('vReason').value = 'Море';
  $('bVac').click(); await tick(120);
  const vb = c.Blocks_all().find((b) => b.reason === 'Море');
  ok('отпуск — одна блокировка на три дня', vb && vb.start_at === c.iso(c.toDate(vFrom, '00:00')) && vb.end_at === c.iso(c.toDate(c.dateOf(c.addDays(c.toDate(vTo, '12:00'), 1)), '00:00')), JSON.stringify(vb));
  $('tabDay').click(); await tick(20);
  w.eval('A').date = new w.Date(c.dateOf(c.addDays(c.toDate(day, '12:00'), 9)) + 'T12:00:00'); w.eval('load')(); await tick(120);
  ok('средний день отпуска показывает блокировку', /Море/.test($('board').textContent));
  w.eval('A').date = new w.Date(c.dateOf(c.addDays(c.toDate(day, '12:00'), 11)) + 'T12:00:00'); w.eval('load')(); await tick(120);
  ok('день после отпуска чистый', !/Море/.test($('board').textContent));

  // правила записи
  $('openRules').click(); await tick(80);
  const inp = (k) => $('sheetBody').querySelector('[data-k="' + k + '"]');
  ok('экран правил: 5 полей, значения из config', w.document.querySelectorAll('.rule').length === 5 && inp('cancel_deadline_hours').value === '4');
  inp('buffer_after_min').value = '30'; inp('horizon_days').value = '500';
  $('rSave').click(); await tick(100);
  ok('неверное значение — ошибка на экране, ничего не записано', !$('rMsg').classList.contains('hide') && c.CFG('buffer_after_min') === '0', $('rMsg').textContent);
  inp('horizon_days').value = '21'; $('rSave').click(); await tick(100);
  ok('правила сохранены', $('sheet').classList.contains('hide') && c.CFG('buffer_after_min') === '30' && c.CFG('horizon_days') === '21');

  // локальная дата без сдвига UTC
  const isoFn = w.eval('iso');
  ok('iso() берёт локальную дату', isoFn(new w.Date(2026, 8, 29, 1, 30)) === '2026-09-29');

  console.log('\nИтог: ' + pass + ' OK, ' + fail + ' FAIL'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
