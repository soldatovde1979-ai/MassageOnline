/** Сквозной тест админки: настоящий admin.html + admin_js.html в jsdom, сервер — эмулятор GAS. */
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

  // локальная дата без сдвига UTC
  const isoFn = w.eval('iso');
  ok('iso() берёт локальную дату', isoFn(new w.Date(2026, 8, 29, 1, 30)) === '2026-09-29');

  console.log('\nИтог: ' + pass + ' OK, ' + fail + ' FAIL'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
