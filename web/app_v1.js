/* app_v1.js — VERSION 1.1 (29.09.2026)
 * Клиентская витрина записи на массаж: статический сайт (GitHub Pages) и Telegram Mini App.
 * Сервер — веб-приложение Apps Script (doPost, JSON). В config.js: API_URL = exec-URL или 'demo'.
 * Контроль версий: APP_MAJOR здесь = <meta name="mb-app-major"> в index.html = MB_CONFIG.APP_MAJOR.
 *
 * 1.1: перенос работал на получасовой ленте неверно (см. durSlots); после отмены, возврата и переноса
 *      лента времени перечитывает затронутые дни. Оба дефекта найдены первым прогоном e2e-теста.
 */
(function () {
  'use strict';

  var APP_VERSION = '1.1';
  var APP_MAJOR = 1;
  var CFG = window.MB_CONFIG || {};
  var root = document.getElementById('app');

  var K = { client: 'mb_client_v1', draft: 'mb_draft_v1', bookings: 'mb_bookings_v1', info: 'mb_info_v1' };
  var CHUNK_DAYS = 14;            // сервер отдаёт не больше 15 дат за запрос
  var MAX_STORED = 20;            // сколько записей помнить на устройстве

  // ------------------------------------------------------------------ утилиты
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  function $(sel) { return root.querySelector(sel); }

  // ------------------------------------------------------------------ время в поясе мастера
  var TZ = 'Europe/Moscow';
  var partsFmt = null;
  function setTz(tz) { TZ = tz || 'Europe/Moscow'; partsFmt = null; }
  function tzParts(ms) {
    partsFmt = partsFmt || new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    });
    var o = {};
    partsFmt.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
    return o;
  }
  function dateKey(ms) { var p = tzParts(ms); return p.year + '-' + p.month + '-' + p.day; }
  function hm(isoStr) { var p = tzParts(Date.parse(isoStr)); return p.hour + ':' + p.minute; }
  var WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  var MON_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  var MON_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  function ymd(key) { var a = key.split('-'); return { y: +a[0], m: +a[1], d: +a[2] }; }
  function weekday(key) { var x = ymd(key); return new Date(Date.UTC(x.y, x.m - 1, x.d)).getUTCDay(); }
  function addDaysKey(key, n) { var x = ymd(key); return new Date(Date.UTC(x.y, x.m - 1, x.d + n)).toISOString().slice(0, 10); }
  function dayLabel(key) {
    var today = dateKey(Date.now());
    var x = ymd(key);
    var base = WD[weekday(key)] + ' ' + x.d + ' ' + MON_GEN[x.m - 1];
    if (key === today) return 'сегодня, ' + base;
    if (key === addDaysKey(today, 1)) return 'завтра, ' + base;
    return base;
  }
  function durText(min) {
    var h = Math.floor(min / 60), m = min % 60;
    return (h ? h + ' ч' : '') + (h && m ? ' ' : '') + (m ? m + ' мин' : '');
  }
  function range(a, b) { return hm(a) + '–' + hm(b); }
  function minutesBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 60000); }

  // ------------------------------------------------------------------ Telegram
  var tg = null;
  try {
    var W = window.Telegram && window.Telegram.WebApp;
    if (W && W.initData) tg = W;
  } catch (e) { tg = null; }

  function haptic(kind) {
    try {
      if (!tg || !tg.HapticFeedback) return;
      if (kind === 'select') tg.HapticFeedback.selectionChanged();
      else tg.HapticFeedback.notificationOccurred(kind);
    } catch (e) { /* старый клиент Telegram */ }
  }
  function openExternal(url) {
    if (tg && /^https?:/i.test(url)) { tg.openLink(url); return; }
    if (/^(tel|mailto):/i.test(url)) { window.location.href = url; return; }
    window.open(url, '_blank', 'noopener');
  }

  // ------------------------------------------------------------------ API
  function ApiError(code, message, retryable) {
    var e = new Error(message || code);
    e.code = code; e.retryable = !!retryable;
    return e;
  }
  function unwrap(res) {
    if (!res || typeof res !== 'object') throw ApiError('BAD_RESPONSE', 'Сервер ответил непонятно', true);
    if (!res.ok) { var er = res.error || {}; throw ApiError(er.code || 'INTERNAL', er.message, er.retryable); }
    return res.data;
  }
  function api(action, payload, o) {
    o = o || {};
    var req = { action: action, request_id: o.requestId || uuid(), auth: o.token ? { token: o.token } : {}, payload: payload || {} };
    if (CFG.API_URL === 'demo') {
      if (!window.MB_DEMO_API) return Promise.reject(ApiError('INTERNAL', 'Демо-режим не загрузился'));
      return window.MB_DEMO_API(req).then(unwrap);
    }
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 30000) : null;
    return fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // простой запрос — без preflight CORS
      body: JSON.stringify(req),
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      if (!r.ok) throw ApiError('NETWORK', 'Сервер ответил ' + r.status, true);
      return r.json();
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      return unwrap(res);
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      if (!e.code) e = ApiError('NETWORK', 'Нет связи с сервером', true);
      if (e.code === 'BUSY' && !o.retried) {
        return wait(3000).then(function () { return api(action, payload, { requestId: req.request_id, token: o.token, retried: true }); });
      }
      throw e;
    });
  }

  // ------------------------------------------------------------------ состояние
  var S = {
    info: store.get(K.info, null),
    order: [],            // даты горизонта
    avail: {},            // 'длительность|дата' -> [{start, end}]
    chunks: {},           // 'длительность|индекс' -> 'loading' | 'done' | 'error'
    date: null,
    userPickedDate: false,
    sel: [],              // индексы выбранных слотов дня
    mode: 'book',         // 'book' | 'resched'
    resched: null,        // { token, booking, slots }
    tab: 'book',
    view: 'pick',         // 'pick' | 'done'
    done: null,
    client: store.get(K.client, null),
    bookings: store.get(K.bookings, []),
    overlay: null,
    pendingReq: null,     // request_id текущей попытки записи — переиспользуется при повторе
    installEvt: null,
    fatal: ''
  };

  function T(vy, ty) { return S.info && S.info.address_form === 'ty' ? ty : vy; }
  // Лента всегда получасовая — и при записи, и при переносе: перенос выделяет S.resched.slots слотов подряд
  // (tapSlot). В 1.0 перенос грузил слоты длиной во всю запись — лента рвалась «занято» между каждым
  // слотом, а tapSlot не находил подряд ни одного (найдено e2e-тестом, 1.1).
  function durSlots() { return 1; }
  function curDuration() { return durSlots() * 30; }
  function daySlots(key) { return S.avail[curDuration() + '|' + (key || S.date)]; }
  function firstName() {
    var n = (S.client && S.client.name) || (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.first_name) || '';
    return String(n).trim().split(/\s+/)[0] || '';
  }
  function serviceId() { return S.info && S.info.services && S.info.services[0] ? S.info.services[0].service_id : ''; }
  function preferredSlots() {
    var last = S.bookings.filter(function (b) { return b.status === 'confirmed' || b.status === 'completed'; })
      .sort(function (a, b) { return a.start_at < b.start_at ? 1 : -1; })[0];
    return last ? Math.round(minutesBetween(last.start_at, last.end_at) / 30) : 0;
  }

  // ------------------------------------------------------------------ загрузка данных
  function loadInfo() {
    return api('public.info', {}).then(function (info) {
      S.info = info;
      setTz(info.timezone);
      store.set(K.info, info);
      buildOrder();
      return info;
    });
  }
  function buildOrder() {
    var today = dateKey(Date.now());
    var n = Math.max(1, (S.info && S.info.horizon_days) || 30);
    S.order = [];
    for (var i = 0; i <= n; i++) S.order.push(addDaysKey(today, i));
  }
  function loadChunk(idx) {
    var dur = curDuration();
    var key = dur + '|' + idx;
    if (S.chunks[key] === 'loading' || S.chunks[key] === 'done') return Promise.resolve();
    var from = S.order[idx], to = S.order[Math.min(idx + CHUNK_DAYS, S.order.length - 1)];
    if (!from) return Promise.resolve();
    S.chunks[key] = 'loading';
    return api('availability.get', { date_from: from, date_to: to, service_id: serviceId(), duration_min: dur })
      .then(function (data) {
        (data.days || []).forEach(function (d) { S.avail[dur + '|' + d.date] = d.slots || []; });
        S.chunks[key] = 'done';
      }, function (e) {
        S.chunks[key] = 'error';
        throw e;
      });
  }
  function loadAll() {
    // первые две недели — сразу, остальное — фоном, по порядку
    var idxs = [];
    for (var i = 0; i < S.order.length; i += CHUNK_DAYS + 1) idxs.push(i);
    var first = loadChunk(idxs[0]).then(afterAvail, onAvailError);
    return idxs.slice(1).reduce(function (p, i) {
      return p.then(function () { return loadChunk(i).then(afterAvail, onAvailError); });
    }, first);
  }
  function reloadDate(key) {
    var dur = curDuration();
    var idx = S.order.indexOf(key);
    if (idx < 0) return Promise.resolve();
    var cidx = idx - (idx % (CHUNK_DAYS + 1));
    delete S.chunks[dur + '|' + cidx];
    return loadChunk(cidx).then(afterAvail, onAvailError);
  }
  function afterAvail() {
    if (!S.userPickedDate) {
      var firstFree = S.order.filter(function (k) { var s = daySlots(k); return s && s.length; })[0];
      if (firstFree && firstFree !== S.date) { S.date = firstFree; S.sel = []; }
      else if (!S.date) S.date = S.order[0];
    }
    if (S.tab === 'book' && S.view === 'pick') { renderDates(); renderRibbon(); renderBar(); renderNearest(); }
  }
  function onAvailError(e) {
    if (S.tab === 'book' && S.view === 'pick') renderRibbon(e);
  }

  // ------------------------------------------------------------------ каркас
  var ICON = {
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg>',
    mine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 4h12v16l-6-4-6 4z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.2-3.6 4-5 7-5s5.8 1.4 7 5"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
  };

  function renderShell() {
    root.innerHTML =
      '<div class="app"><div id="offline"></div><main id="view" tabindex="-1"></main></div>' +
      '<div id="bar-host"></div>' +
      '<nav class="tabs" aria-label="Разделы"><div class="tabs-inner" role="tablist">' +
      tabBtn('book', 'Записаться') + tabBtn('mine', 'Мои записи') + tabBtn('info', 'О мастере') +
      '</div></nav>' +
      '<div id="overlay"></div><div id="toast-host" aria-live="polite"></div>';
    renderOffline();
  }
  function tabBtn(id, label) {
    return '<button class="tab" role="tab" data-act="tab" data-tab="' + id + '" aria-selected="' + (S.tab === id) + '">' +
      ICON[id] + '<span>' + label + '</span><span class="badge-slot"></span></button>';
  }
  function renderTabs() {
    Array.prototype.forEach.call(root.querySelectorAll('.tab'), function (b) {
      b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === S.tab));
    });
    var n = upcoming().filter(function (b) { return b.status === 'confirmed'; }).length;
    var slot = root.querySelector('.tab[data-tab="mine"] .badge-slot');
    if (slot) slot.innerHTML = n ? '<span class="badge" aria-label="активных записей: ' + n + '">' + n + '</span>' : '';
  }
  function renderOffline() {
    var el = $('#offline');
    if (!el) return;
    el.innerHTML = navigator.onLine === false ? '<div class="offline" role="status">Нет интернета — показаны последние сохранённые данные</div>' : '';
  }

  function render() {
    renderTabs();
    var v = $('#view');
    if (!v) return;
    $('#bar-host').innerHTML = '';
    if (S.tab === 'book') {
      if (S.view === 'done') renderDone(v);
      else renderPick(v);
    } else if (S.tab === 'mine') renderMine(v);
    else renderInfo(v);
  }

  // ------------------------------------------------------------------ вкладка «Записаться»
  function renderPick(v) {
    var name = firstName();
    var title, sub;
    if (S.mode === 'resched') {
      title = 'Перенос записи';
      sub = T('Выберите новое время. Длительность останется прежней — ', 'Выбери новое время. Длительность останется прежней — ') + durText(curDuration()) + '.';
    } else if (name) {
      title = T('Здравствуйте, ', 'Привет, ') + name;
      sub = T('Выберите удобное время — ваши данные уже заполнены.', 'Выбирай удобное время — данные уже заполнены.');
    } else {
      title = 'Запись на массаж';
      sub = T('Выберите день и время. Это займёт меньше минуты.', 'Выбирай день и время. Это займёт меньше минуты.');
    }
    v.innerHTML =
      '<header class="hero"><h1>' + esc(title) + '</h1><p>' + esc(sub) + '</p><div id="nearest"></div></header>' +
      (CFG.API_URL === 'demo' ? '<p class="demo-note">Демо-режим: записи не настоящие, мастеру ничего не придёт.</p>' : '') +
      (S.mode === 'resched' ? '<div class="resched"><p>Сейчас: ' + esc(dayLabel(dateKey(Date.parse(S.resched.booking.start_at)))) + ', ' +
        esc(range(S.resched.booking.start_at, S.resched.booking.end_at)) + '</p><button class="btn ghost small" data-act="resched-abort">Не переносить</button></div>' : '') +
      '<div class="month" id="month"></div>' +
      '<div class="dates" id="dates" role="group" aria-label="Дата"></div>' +
      '<p class="hint" id="hint"></p>' +
      '<ol class="ribbon" id="ribbon" aria-label="Свободное время"></ol>';
    renderDates(true);
    renderRibbon();
    renderBar();
    renderNearest();
  }

  function renderNearest() {
    var el = $('#nearest');
    if (!el) return;
    if (S.mode === 'resched' || S.sel.length) { el.innerHTML = ''; return; }
    var key = S.order.filter(function (k) { var s = daySlots(k); return s && s.length; })[0];
    if (!key || key === S.date) { el.innerHTML = ''; return; }
    var s = daySlots(key)[0];
    el.innerHTML = '<p style="margin-top:14px"><button class="btn soft small" data-act="goto" data-date="' + key + '" data-start="' + esc(s.start) +
      '">Ближайшее: ' + esc(dayLabel(key)) + ', ' + esc(hm(s.start)) + '</button></p>';
  }

  function renderDates(force) {
    var box = $('#dates');
    if (!box) return;
    var keep = box.scrollLeft;
    var html = S.order.map(function (k) {
      var slots = daySlots(k);
      var state = slots === undefined ? 'loading' : (slots.length ? 'free' : 'none');
      var x = ymd(k);
      var label = dayLabel(k) + (state === 'none' ? ', нет свободного времени' : '');
      return '<button class="date" data-act="date" data-date="' + k + '" data-state="' + state + '" aria-pressed="' + (k === S.date) + '" aria-label="' + esc(label) + '">' +
        '<span class="wd">' + WD[weekday(k)] + '</span><span class="dn">' + x.d + '</span><span class="dot"></span></button>';
    }).join('');
    if (force || box.innerHTML !== html) box.innerHTML = html;
    box.scrollLeft = keep; // перерисовка не должна отматывать ленту (Т-10)
    var m = $('#month');
    if (m && S.date) m.textContent = MON_NOM[ymd(S.date).m - 1] + (ymd(S.date).y !== ymd(dateKey(Date.now())).y ? ' ' + ymd(S.date).y : '');
  }
  function scrollDateIntoView() {
    var btn = root.querySelector('.date[aria-pressed="true"]');
    var box = $('#dates');
    if (!btn || !box) return;
    var left = btn.offsetLeft - 20;
    if (left < box.scrollLeft || left + btn.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = Math.max(0, left);
  }

  function renderHint() {
    var h = $('#hint');
    if (!h || !S.info) return;
    if (S.mode === 'resched') { h.textContent = T('Нажмите на время начала.', 'Нажми на время начала.'); return; }
    var min = S.info.min_slots, max = S.info.max_slots;
    var pref = preferredSlots();
    h.textContent = T('Можно выбрать несколько получасовых слотов подряд — от ', 'Можно выбрать несколько получасовых слотов подряд — от ') +
      durText(min * 30) + ' до ' + durText(max * 30) + '. ' +
      T('Нажмите на начало, потом на последний слот.', 'Нажми на начало, потом на последний слот.') +
      (pref && pref !== min ? ' ' + T('Как в прошлый раз', 'Как в прошлый раз') + ' — ' + durText(pref * 30) + ' выберется сразу.' : '');
  }

  function renderRibbon(err) {
    var ol = $('#ribbon');
    if (!ol) return;
    renderHint();
    var slots = S.date ? daySlots() : undefined;
    if (err && slots === undefined) {
      ol.innerHTML = '<li class="empty">Не получилось загрузить расписание. ' + esc(err.code === 'NETWORK' ? 'Проверьте интернет.' : (err.message || '')) +
        '<br><button class="btn small" data-act="retry-avail">Повторить</button></li>';
      return;
    }
    if (slots === undefined) {
      ol.className = 'ribbon skeleton';
      ol.innerHTML = [0, 1, 2, 3, 4].map(function () { return '<li class="slot"><span class="t">&nbsp;</span><button disabled tabindex="-1">&nbsp;</button></li>'; }).join('');
      return;
    }
    ol.className = 'ribbon';
    if (!slots.length) {
      var next = S.order.filter(function (k) { return k > S.date && daySlots(k) && daySlots(k).length; })[0];
      ol.innerHTML = '<li class="empty">В этот день свободного времени нет.' +
        (next ? '<br><button class="btn soft small" data-act="date" data-date="' + next + '">Ближайшее свободное — ' + esc(dayLabel(next)) + '</button>' : '') + '</li>';
      return;
    }
    var selSet = {};
    S.sel.forEach(function (i) { selSet[i] = true; });
    var a = S.sel[0], b = S.sel[S.sel.length - 1];
    var html = '';
    slots.forEach(function (s, i) {
      if (i > 0 && slots[i - 1].end !== s.start) html += '<li class="gap" aria-hidden="true">занято</li>';
      var sel = !!selSet[i];
      var cls = 'slot' + (sel ? ' sel' : '') + (i === a ? ' first' : '') + (i === b ? ' last' : '');
      var inner = '';
      if (sel && i === a) {
        var st = slots[a].start, en = slots[b].end;
        inner = '<span class="band">' + esc(range(st, en)) + '</span><span class="dur">' + esc(durText(minutesBetween(st, en))) + '</span>';
      } else if (!sel) inner = 'свободно';
      html += '<li class="' + cls + '"><span class="t">' + esc(hm(s.start)) + '</span>' +
        '<button data-act="slot" data-i="' + i + '" aria-pressed="' + sel + '" aria-label="' + esc(range(s.start, s.end) + (sel ? ', выбрано' : ', свободно')) + '">' + inner + '</button></li>';
    });
    ol.innerHTML = html;
  }

  function renderBar() {
    var host = $('#bar-host');
    if (!host) return;
    if (S.tab !== 'book' || S.view !== 'pick') { host.innerHTML = ''; return; }
    var slots = daySlots() || [];
    var has = S.sel.length && slots[S.sel[0]];
    var what, btn;
    if (has) {
      var st = slots[S.sel[0]].start, en = slots[S.sel[S.sel.length - 1]].end;
      what = '<b>' + esc(range(st, en)) + '</b><span>' + esc(dayLabel(S.date) + ', ' + durText(minutesBetween(st, en))) + '</span>';
    } else {
      what = '<b>' + (S.mode === 'resched' ? 'Новое время' : 'Выберите время') + '</b><span>' +
        esc(S.date ? dayLabel(S.date) : 'дата не выбрана') + '</span>';
    }
    btn = S.mode === 'resched'
      ? '<button class="btn" data-act="resched-confirm"' + (has ? '' : ' disabled') + '>Перенести сюда</button>'
      : '<button class="btn" data-act="continue"' + (has ? '' : ' disabled') + '>Продолжить</button>';
    host.innerHTML = '<div class="bar"><div class="bar-inner"><div class="what">' + what + '</div>' + btn + '</div></div>';
  }

  // выбор слотов: тап по началу, затем по последнему слоту; разрыв — ошибка (Т-9)
  function runFrom(i) {
    var slots = daySlots() || [], n = 0;
    for (var k = i; k < slots.length; k++) {
      if (k > i && slots[k - 1].end !== slots[k].start) break;
      n++;
    }
    return n;
  }
  function contiguous(a, b) {
    var slots = daySlots() || [];
    for (var k = a + 1; k <= b; k++) if (slots[k - 1].end !== slots[k].start) return false;
    return true;
  }
  function setSel(a, b) { S.sel = []; for (var k = a; k <= b; k++) S.sel.push(k); }
  function startAt(i) {
    var slots = daySlots();
    var min = S.info.min_slots, max = S.info.max_slots;
    var run = runFrom(i);
    var want = Math.min(Math.max(min, preferredSlots() || min), max);
    if (run >= want) setSel(i, i + want - 1);
    else if (run >= min) setSel(i, i + run - 1);
    else {
      toast('С ' + hm(slots[i].start) + ' свободно только ' + durText(run * 30) + ', а записаться можно минимум на ' + durText(min * 30) + '. ' +
        T('Выберите другое время.', 'Выбери другое время.'), { error: true });
      return false;
    }
    return true;
  }
  function tapSlot(i) {
    var slots = daySlots();
    if (!slots || !slots[i] || !S.info) return;
    if (S.mode === 'resched') {
      var need = S.resched.slots;
      if (runFrom(i) >= need) setSel(i, i + need - 1);
      else { toast('С ' + hm(slots[i].start) + ' не помещается ' + durText(need * 30) + '. ' + T('Выберите другое начало.', 'Выбери другое начало.'), { error: true }); return; }
    } else if (!S.sel.length) {
      if (!startAt(i)) return;
    } else {
      var a = S.sel[0], b = S.sel[S.sel.length - 1];
      var min = S.info.min_slots, max = S.info.max_slots;
      if (i === a) S.sel = [];
      else if (i > a && i <= b) {
        if (i - a + 1 < min) { toast('Минимум — ' + durText(min * 30) + '.', { error: true }); return; }
        setSel(a, i);
      } else if (i > b) {
        if (!contiguous(b, i)) {
          toast(T('Между выбранным временем и ', 'Между выбранным временем и ') + hm(slots[i].start) + ' есть занятое время. ' +
            T('Выберите слоты подряд, без разрыва.', 'Выбери слоты подряд, без разрыва.'), { error: true });
          haptic('error');
          return;
        }
        if (i - a + 1 > max) { toast('За один раз можно записаться максимум на ' + durText(max * 30) + '.', { error: true }); return; }
        setSel(a, i);
      } else if (!startAt(i)) return;
    }
    haptic('select');
    S.pendingReq = null;
    renderRibbon(); renderBar(); renderNearest();
  }

  // ------------------------------------------------------------------ оформление записи
  function selection() {
    var slots = daySlots() || [];
    if (!S.sel.length) return null;
    var st = slots[S.sel[0]].start, en = slots[S.sel[S.sel.length - 1]].end;
    return { start: st, end: en, slots: S.sel.length };
  }

  function openBookSheet(errors) {
    var sel = selection();
    if (!sel) return;
    var draft = store.get(K.draft, {});
    var c = S.client;
    var tgName = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.first_name : '';
    var editing = !c || (S.overlay && S.overlay.editing);
    errors = errors || {};
    var fields = editing
      ? field('name', 'Имя', 'text', draft.name || (c && c.name) || tgName || '', 'given-name', errors.name) +
        field('phone', 'Телефон', 'tel', draft.phone || (c && c.phone) || '', 'tel', errors.phone)
      : '<div class="known"><div><b>' + esc(c.name) + '</b><span>' + esc(fmtPhone(c.phone)) + '</span></div>' +
        '<button type="button" class="link" data-act="edit-contacts">Изменить</button></div>';
    openOverlay('book',
      '<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t"><div class="grab"></div>' +
      '<h2 id="sh-t">' + esc(range(sel.start, sel.end)) + '</h2>' +
      '<p class="sub">' + esc(dayLabel(dateKey(Date.parse(sel.start))) + ', ' + durText(minutesBetween(sel.start, sel.end))) + '</p>' +
      '<form id="book-form" novalidate>' + fields +
      '<label class="field"><span>Пожелания — по желанию</span><textarea name="comment" maxlength="500" placeholder="Например: шея и плечи, нажим посильнее">' +
      esc(draft.comment || '') + '</textarea></label>' +
      (errors.form ? '<p class="field"><span class="err">' + esc(errors.form) + '</span></p>' : '') +
      '<button class="btn block" type="submit" id="book-submit">Записаться на ' + esc(range(sel.start, sel.end)) + '</button>' +
      '</form></div></div>', { editing: editing });
    var first = root.querySelector('#book-form input');
    if (first && !first.value) first.focus();
  }
  function field(name, label, type, value, ac, err) {
    return '<label class="field' + (err ? ' error' : '') + '"><span>' + label + '</span>' +
      '<input name="' + name + '" type="' + type + '" value="' + esc(value) + '" autocomplete="' + ac + '"' +
      (type === 'tel' ? ' inputmode="tel" placeholder="+7 900 000-00-00"' : '') + ' maxlength="60">' +
      (err ? '<span class="err">' + esc(err) + '</span>' : '') + '</label>';
  }
  function normPhone(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
    if (d.length === 10) d = '7' + d;
    return d.length === 11 && d[0] === '7' ? '+' + d : '';
  }
  function fmtPhone(p) {
    var d = String(p || '').replace(/\D/g, '');
    if (d.length !== 11) return p || '';
    return '+' + d[0] + ' ' + d.slice(1, 4) + ' ' + d.slice(4, 7) + '-' + d.slice(7, 9) + '-' + d.slice(9);
  }

  function submitBooking(form) {
    var sel = selection();
    if (!sel || S.overlay.busy) return;
    var fd = {};
    Array.prototype.forEach.call(form.elements, function (el) { if (el.name) fd[el.name] = el.value.trim(); });
    var client = S.client && !S.overlay.editing ? { client_id: S.client.client_id, name: S.client.name, phone: S.client.phone }
      : { client_id: S.client ? S.client.client_id : '', name: fd.name, phone: fd.phone };
    var errs = {};
    if (!client.name || client.name.length < 2) errs.name = T('Как к вам обращаться?', 'Как тебя зовут?');
    if (!normPhone(client.phone)) errs.phone = 'Нужен номер из 10 цифр после +7';
    if (errs.name || errs.phone) { openBookSheet(errs); haptic('error'); return; }
    S.pendingReq = S.pendingReq || uuid();
    S.overlay.busy = true;
    var btn = $('#book-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Записываем…'; }
    var payload = {
      service_id: serviceId(), start_at: sel.start, slots_count: sel.slots,
      client: client, comment: fd.comment || '', source: tg ? 'telegram' : 'web'
    };
    if (tg) payload.tg_init_data = tg.initData;
    api('booking.create', payload, { requestId: S.pendingReq }).then(function (data) {
      S.pendingReq = null;
      if (data.client_echo) {
        S.client = { client_id: data.client_echo.client_id, name: data.client_echo.name, phone: data.client_echo.phone, saved_at: new Date().toISOString() };
        store.set(K.client, S.client);
      }
      store.del(K.draft);
      rememberBooking({ token: tokenFromUrl(data.manage_url), booking_id: data.booking_id, start_at: data.start_at, end_at: data.end_at, status: 'confirmed' });
      S.done = { start_at: data.start_at, end_at: data.end_at, token: tokenFromUrl(data.manage_url), after_booking: '' };
      closeOverlay();
      S.view = 'done'; S.sel = [];
      haptic('success');
      render();
      window.scrollTo(0, 0);
      refreshMine(true);                 // подтянуть код домофона и флаги
      reloadDate(dateKey(Date.parse(data.start_at)));
    }).catch(function (e) {
      S.overlay.busy = false;
      haptic('error');
      if (e.code === 'SLOT_TAKEN') {
        S.pendingReq = null;
        closeOverlay(); S.sel = [];
        toast(T('Это время только что заняли. Выберите другое.', 'Это время только что заняли. Выбери другое.'), { error: true });
        reloadDate(S.date);
        return;
      }
      if (e.code === 'BAD_PHONE') { openBookSheet({ phone: e.message }); return; }
      if (e.code === 'NETWORK' || e.code === 'BAD_RESPONSE') {
        openBookSheet({ form: 'Нет связи с сервером. Проверьте интернет и нажмите ещё раз — дубля не будет.' });
        return;
      }
      openBookSheet({ form: e.message || 'Не получилось записаться' });
    });
  }

  function tokenFromUrl(url) {
    var m = String(url || '').match(/[?&]t=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function rememberBooking(b) {
    if (!b.token) return;
    var list = S.bookings.filter(function (x) { return x.booking_id !== b.booking_id; });
    list.push(b);
    list.sort(function (x, y) { return x.start_at < y.start_at ? 1 : -1; });
    S.bookings = list.slice(0, MAX_STORED);
    store.set(K.bookings, S.bookings);
    renderTabs();
  }

  function renderDone(v) {
    var d = S.done;
    var info = S.info || {};
    var key = dateKey(Date.parse(d.start_at));
    var notes = '';
    if (d.after_booking) notes += noteBlock('Как попасть', d.after_booking);
    if (info.studio_address) notes += noteBlock('Адрес', info.studio_address + (info.studio_directions ? '\n' + info.studio_directions : ''));
    if (info.studio_bring) notes += noteBlock('Что взять с собой', info.studio_bring);
    v.innerHTML =
      '<section class="done"><div class="mark">' + ICON.check + '</div>' +
      '<h1>Запись подтверждена</h1>' +
      '<p class="when">' + esc(range(d.start_at, d.end_at)) + '</p>' +
      '<p class="when-day">' + esc(dayLabel(key) + ', ' + durText(minutesBetween(d.start_at, d.end_at))) + '</p>' +
      '<div class="stack">' +
      '<button class="btn" data-act="gcal" data-token="' + esc(d.token) + '">Добавить в Google Календарь</button>' +
      '<button class="btn ghost" data-act="ics" data-token="' + esc(d.token) + '">Скачать для календаря iPhone</button>' +
      '<button class="btn soft" data-act="tab" data-tab="mine">Мои записи</button>' +
      '</div>' + notes +
      '<p class="foot">' + esc(T('Отменить или перенести можно в «Мои записи» — не позже чем за ', 'Отменить или перенести можно в «Мои записи» — не позже чем за ') +
        (info.cancel_deadline_hours || 4) + ' ч до начала.') + '</p>' +
      '<p><button class="btn ghost block" data-act="book-more">Записаться ещё</button></p></section>';
  }
  function noteBlock(title, text) {
    return '<div class="note"><h3>' + esc(title) + '</h3><p>' + esc(text) + '</p></div>';
  }

  // ------------------------------------------------------------------ «Мои записи»
  function upcoming() {
    var now = Date.now();
    return S.bookings.filter(function (b) {
      return Date.parse(b.end_at) > now && (b.status === 'confirmed' || b.can_restore || b.status === 'cancelled_by_master');
    }).sort(function (a, b) { return a.start_at < b.start_at ? -1 : 1; });
  }
  function past() {
    var now = Date.now();
    return S.bookings.filter(function (b) { return Date.parse(b.end_at) <= now && b.status !== 'cancelled_by_client'; })
      .sort(function (a, b) { return a.start_at < b.start_at ? 1 : -1; }).slice(0, 10);
  }
  var mineLoading = false;
  function refreshMine(silent) {
    var tokens = S.bookings.map(function (b) { return b.token; }).filter(Boolean);
    if (!tokens.length) { if (S.tab === 'mine') render(); return Promise.resolve(); }
    mineLoading = true;
    if (!silent && S.tab === 'mine') render();
    return api('client.bookings', { tokens: tokens }).then(function (data) {
      mineLoading = false;
      var bad = {};
      (data.invalid || []).forEach(function (x) { bad[x.token] = x.code; });
      var fresh = {};
      (data.items || []).forEach(function (it) { fresh[it.booking_id] = it; });
      S.bookings = S.bookings.filter(function (b) { return !bad[b.token]; }).map(function (b) {
        var it = fresh[b.booking_id];
        return it ? it : b;
      });
      store.set(K.bookings, S.bookings);
      if (S.done && fresh[bookingIdByToken(S.done.token)]) {
        S.done.after_booking = fresh[bookingIdByToken(S.done.token)].after_booking || '';
        if (S.tab === 'book' && S.view === 'done') render();
      }
      if (S.tab === 'mine') render(); else renderTabs();
    }, function (e) {
      mineLoading = false;
      if (S.tab === 'mine') { render(); if (!silent) toast('Не получилось обновить записи: ' + (e.code === 'NETWORK' ? 'нет связи' : e.message), { error: true }); }
    });
  }
  function bookingIdByToken(t) {
    var b = S.bookings.filter(function (x) { return x.token === t; })[0];
    return b ? b.booking_id : String(t).split('.')[0];
  }
  function byToken(t) { return S.bookings.filter(function (x) { return x.token === t; })[0]; }

  function renderMine(v) {
    var up = upcoming(), ps = past();
    var html = '<h2 class="section-title">Мои записи</h2>';
    if (mineLoading && !S.bookings.length) html += '<p class="hint">Загружаем…</p>';
    if (!up.length) {
      html += '<div class="empty">' + (S.bookings.length ? 'Предстоящих записей нет.' : 'Здесь появятся ваши записи с этого устройства.') +
        '<br><button class="btn small" data-act="tab" data-tab="book">Выбрать время</button></div>';
    }
    html += up.map(card).join('');
    if (ps.length) html += '<details class="past"><summary>Прошедшие (' + ps.length + ')</summary>' + ps.map(card).join('') + '</details>';
    v.innerHTML = html;
  }
  function card(b) {
    var key = dateKey(Date.parse(b.start_at));
    var cancelled = b.status === 'cancelled_by_client' || b.status === 'cancelled_by_master';
    var chip = b.status === 'cancelled_by_client' ? '<span class="chip">Отменена</span>'
      : b.status === 'cancelled_by_master' ? '<span class="chip">Отменена мастером</span>'
      : b.status === 'completed' ? '<span class="chip ok">Состоялась</span>'
      : b.status === 'no_show' ? '<span class="chip">Пропущена</span>' : '';
    var acts = '';
    var t = esc(b.token);
    if (b.status === 'confirmed' && !b.is_past && Date.parse(b.start_at) > Date.now()) {
      if (b.can_reschedule !== false) acts += '<button class="btn soft small" data-act="resched" data-token="' + t + '">Перенести</button>';
      if (b.can_cancel !== false) acts += '<button class="btn ghost small" data-act="cancel" data-token="' + t + '">Отменить</button>';
      acts += '<button class="btn ghost small" data-act="gcal" data-token="' + t + '">В календарь</button>';
      if (b.can_cancel === false) acts += '<p class="meta" style="flex-basis:100%;margin:4px 0 0">Отменить через приложение уже нельзя' +
        (S.info && S.info.master_phone ? ' — <a href="tel:' + esc(S.info.master_phone) + '">позвоните мастеру</a>' : ' — напишите мастеру') + '.</p>';
    }
    if (b.can_restore && b.restore_until) {
      var left = Math.max(1, Math.round((Date.parse(b.restore_until) - Date.now()) / 60000));
      acts += '<button class="btn small" data-act="restore" data-token="' + t + '">Вернуть запись</button>' +
        '<span class="meta" style="align-self:center">ещё ' + left + ' мин</span>';
    }
    return '<article class="card' + (cancelled ? ' cancelled' : '') + '">' + chip +
      '<p class="when">' + esc(range(b.start_at, b.end_at)) + '</p>' +
      '<p class="meta">' + esc(dayLabel(key) + ', ' + durText(minutesBetween(b.start_at, b.end_at))) + '</p>' +
      (b.after_booking && b.status === 'confirmed' ? '<div class="note" style="margin:0 0 12px"><p>' + esc(b.after_booking) + '</p></div>' : '') +
      (acts ? '<div class="actions">' + acts + '</div>' : '') + '</article>';
  }

  function askCancel(token) {
    var b = byToken(token);
    if (!b) return;
    var win = S.info && S.info.restore_window_min;
    openOverlay('confirm',
      '<div class="scrim" data-act="scrim"><div class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="cf-t"><div class="grab"></div>' +
      '<h2 id="cf-t">Отменить запись?</h2><p class="sub">' + esc(dayLabel(dateKey(Date.parse(b.start_at))) + ', ' + range(b.start_at, b.end_at)) +
      (win ? '. Передумаете — вернуть можно в течение ' + win + ' мин.' : '.') + '</p>' +
      '<div class="stack"><button class="btn danger" data-act="cancel-yes" data-token="' + esc(token) + '">Отменить запись</button>' +
      '<button class="btn ghost" data-act="close">Оставить</button></div></div></div>');
  }
  function doCancel(token, btn) {
    var b = byToken(token);
    if (btn) { btn.disabled = true; btn.textContent = 'Отменяем…'; }
    api('booking.cancel', {}, { token: token }).then(function () {
      closeOverlay();
      haptic('success');
      toast('Запись отменена. Мастер получит уведомление.');
      if (b) reloadDate(dateKey(Date.parse(b.start_at)));   // освободившееся время — сразу в ленту (1.1)
      return refreshMine(true);
    }).catch(function (e) {
      closeOverlay();
      haptic('error');
      toast(e.code === 'TOO_LATE' ? e.message : ('Не получилось отменить: ' + (e.message || e.code)), { error: true });
      refreshMine(true);
    });
  }
  function doRestore(token, btn) {
    var was = byToken(token);
    if (btn) { btn.disabled = true; btn.textContent = 'Возвращаем…'; }
    api('booking.restore', {}, { token: token }).then(function (data) {
      haptic('success');
      if (data && data.manage_url) {
        var b = byToken(token);
        if (b) { b.token = tokenFromUrl(data.manage_url) || b.token; store.set(K.bookings, S.bookings); }
      }
      if (was) reloadDate(dateKey(Date.parse(was.start_at)));  // время снова занято — убрать из ленты (1.1)
      toast('Запись снова в силе.');
      return refreshMine(true);
    }).catch(function (e) {
      haptic('error');
      toast(e.code === 'SLOT_TAKEN' ? 'Это время уже занял кто-то другой — выберите новое.' : (e.message || 'Не получилось вернуть запись'), { error: true });
      refreshMine(true);
    });
  }
  function startResched(token) {
    var b = byToken(token);
    if (!b) return;
    S.mode = 'resched';
    S.resched = { token: token, booking: b, slots: Math.round(minutesBetween(b.start_at, b.end_at) / 30) };
    S.sel = []; S.tab = 'book'; S.view = 'pick';
    S.date = dateKey(Date.parse(b.start_at)); S.userPickedDate = true;
    render();
    loadAll();
    window.scrollTo(0, 0);
  }
  function stopResched() {
    S.mode = 'book'; S.resched = null; S.sel = [];
    render();
  }
  function confirmResched(btn) {
    var sel = selection();
    if (!sel) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Переносим…'; }
    var old = S.resched;
    api('booking.reschedule', { start_at: sel.start }, { token: old.token }).then(function (data) {
      haptic('success');
      var nb = { token: tokenFromUrl(data.manage_url) || old.token, booking_id: data.booking_id || old.booking.booking_id,
        start_at: data.start_at, end_at: data.end_at, status: 'confirmed' };
      S.bookings = S.bookings.filter(function (x) { return x.token !== old.token; });
      rememberBooking(nb);
      // старое время освободилось, новое занято — лента не должна показывать прошлое состояние (1.1)
      reloadDate(dateKey(Date.parse(old.booking.start_at)));
      reloadDate(dateKey(Date.parse(nb.start_at)));
      S.mode = 'book'; S.resched = null; S.sel = [];
      S.tab = 'mine';
      render();
      toast('Перенесли на ' + dayLabel(dateKey(Date.parse(nb.start_at))) + ', ' + range(nb.start_at, nb.end_at) + '.');
      refreshMine(true);
    }).catch(function (e) {
      haptic('error');
      if (btn) { btn.disabled = false; btn.textContent = 'Перенести сюда'; }
      toast(e.code === 'SLOT_TAKEN' ? T('Это время только что заняли. Выберите другое.', 'Это время только что заняли. Выбери другое.') : (e.message || 'Не получилось перенести'), { error: true });
      if (e.code === 'SLOT_TAKEN') { S.sel = []; reloadDate(S.date); }
    });
  }

  // ------------------------------------------------------------------ календарь клиента
  function calendarData(token) {
    var b = byToken(token) || (S.done && S.done.token === token ? S.done : null);
    if (!b) return null;
    var info = S.info || {};
    return {
      title: 'Массаж' + (info.master_name ? ' (' + info.master_name + ')' : ''),
      start: b.start_at, end: b.end_at,
      location: info.studio_address || '',
      details: [info.studio_directions, info.master_phone ? 'Телефон мастера: ' + info.master_phone : ''].filter(Boolean).join('\n')
    };
  }
  function utcStamp(isoStr) { return new Date(Date.parse(isoStr)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
  function googleCalendarUrl(c) {
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(c.title) +
      '&dates=' + utcStamp(c.start) + '/' + utcStamp(c.end) +
      '&details=' + encodeURIComponent(c.details) + '&location=' + encodeURIComponent(c.location);
  }
  function icsText(c) {
    var escI = function (s) { return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); };
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//massage_booking_app//RU', 'BEGIN:VEVENT',
      'UID:' + utcStamp(c.start) + '-' + Math.random().toString(36).slice(2) + '@massage',
      'DTSTAMP:' + utcStamp(new Date().toISOString()),
      'DTSTART:' + utcStamp(c.start), 'DTEND:' + utcStamp(c.end),
      'SUMMARY:' + escI(c.title), 'LOCATION:' + escI(c.location), 'DESCRIPTION:' + escI(c.details),
      'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', 'DESCRIPTION:' + escI(c.title), 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  }
  function downloadIcs(c) {
    var blob = new Blob([icsText(c)], { type: 'text/calendar;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'massage.ics';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ------------------------------------------------------------------ вкладка «О мастере»
  function renderInfo(v) {
    var i = S.info || {};
    var name = i.master_name || 'Мастер';
    var html = '<div class="master"><div class="avatar" aria-hidden="true">' + esc(name.charAt(0).toUpperCase()) + '</div><div><h2>' + esc(name) + '</h2>' +
      (i.master_about ? '<p>' + esc(i.master_about) + '</p>' : '') + '</div></div>';
    var contacts = '';
    if (i.master_phone) contacts += '<a class="btn small" href="tel:' + esc(i.master_phone) + '">Позвонить</a>';
    if (i.bot_username) contacts += '<button class="btn soft small" data-act="open" data-url="https://t.me/' + esc(i.bot_username) + '">Написать в Telegram</button>';
    if (contacts) html += '<div class="info-block"><h3>Связаться</h3><div class="row-actions">' + contacts + '</div></div>';
    if (i.studio_address) {
      html += '<div class="info-block"><h3>Адрес</h3><p>' + esc(i.studio_address) + '</p>' +
        (i.studio_directions ? '<p>' + esc(i.studio_directions) + '</p>' : '') +
        '<div class="row-actions"><button class="btn soft small" data-act="open" data-url="https://yandex.ru/maps/?text=' + encodeURIComponent(i.studio_address) + '">Открыть в Картах</button></div></div>';
    }
    if (i.studio_bring) html += '<div class="info-block"><h3>Что взять с собой</h3><p>' + esc(i.studio_bring) + '</p></div>';
    if (i.min_slots) {
      html += '<div class="info-block"><h3>Как устроена запись</h3><p>Сеанс — от ' + esc(durText(i.min_slots * 30)) + ' до ' + esc(durText(i.max_slots * 30)) +
        ', время выбирается получасовыми шагами.\nЗаписаться можно не позже чем за ' + esc(durText(i.lead_time_min || 0) || '0 мин') +
        ' до начала, отменить или перенести — не позже чем за ' + esc(String(i.cancel_deadline_hours)) + ' ч.\nЗапись открыта на ' + esc(String(i.horizon_days)) + ' дней вперёд.' +
        (i.restore_window_min ? '\nОтменили по ошибке — запись можно вернуть в течение ' + i.restore_window_min + ' мин.' : '') + '</p></div>';
    }
    var install = '';
    if (S.installEvt) install = '<button class="btn soft small" data-act="install">Установить на телефон</button>';
    else if (!tg && /iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone) {
      install = '<p>На iPhone: кнопка «Поделиться» в Safari → «На экран „Домой“». Запись будет открываться как приложение.</p>';
    }
    if (install) html += '<div class="info-block"><h3>Как приложение</h3>' + install + '</div>';
    html += '<p class="foot">' + (S.client ? 'На этом устройстве сохранены ваше имя и телефон, чтобы не вводить их заново. ' +
      '<button class="link" data-act="forget">Забыть мои данные</button>' : 'Имя и телефон сохранятся на этом устройстве после первой записи.') +
      '<br>Версия ' + APP_VERSION + '</p>';
    v.innerHTML = html;
  }

  // ------------------------------------------------------------------ листы, тосты
  function openOverlay(kind, html, extra) {
    S.overlay = Object.assign({ kind: kind, busy: false }, extra || {});
    $('#overlay').innerHTML = html;
    if (tg && tg.BackButton) { try { tg.BackButton.show(); } catch (e) { /* ignore */ } }
  }
  function closeOverlay() {
    S.overlay = null;
    var o = $('#overlay');
    if (o) o.innerHTML = '';
    if (tg && tg.BackButton) { try { tg.BackButton.hide(); } catch (e) { /* ignore */ } }
  }
  var toastTimer = null;
  function toast(text, o) {
    o = o || {};
    var host = $('#toast-host');
    if (!host) return;
    host.innerHTML = '<div class="toast' + (o.error ? ' error' : '') + '" role="' + (o.error ? 'alert' : 'status') + '"><span>' + esc(text) + '</span></div>';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { host.innerHTML = ''; }, o.error ? 6000 : 3500);
  }

  // ------------------------------------------------------------------ события
  function onClick(e) {
    var el = e.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    var act = el.getAttribute('data-act');
    if (act === 'scrim') { if (e.target === el && !(S.overlay && S.overlay.busy)) closeOverlay(); return; }
    switch (act) {
      case 'tab':
        S.tab = el.getAttribute('data-tab');
        if (S.tab === 'book' && S.view === 'done') { S.view = 'pick'; }
        render();
        if (S.tab === 'mine') refreshMine();
        if (S.tab === 'book' && S.view === 'pick') scrollDateIntoView();
        window.scrollTo(0, 0);
        break;
      case 'date':
        S.date = el.getAttribute('data-date'); S.userPickedDate = true; S.sel = []; S.pendingReq = null;
        Array.prototype.forEach.call(root.querySelectorAll('.date'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-date') === S.date)); });
        renderDates(); scrollDateIntoView(); renderRibbon(); renderBar(); renderNearest();
        haptic('select');
        break;
      case 'goto':
        S.date = el.getAttribute('data-date'); S.userPickedDate = true; S.sel = [];
        renderDates(); scrollDateIntoView(); renderRibbon();
        var idx = (daySlots() || []).map(function (s) { return s.start; }).indexOf(el.getAttribute('data-start'));
        if (idx >= 0) tapSlot(idx); else { renderBar(); renderNearest(); }
        break;
      case 'slot': tapSlot(parseInt(el.getAttribute('data-i'), 10)); break;
      case 'retry-avail': S.chunks = {}; loadAll(); renderRibbon(); break;
      case 'continue': openBookSheet(); break;
      case 'edit-contacts': S.overlay.editing = true; openBookSheet(); break;
      case 'close': closeOverlay(); break;
      case 'book-more': S.view = 'pick'; render(); break;
      case 'cancel': askCancel(el.getAttribute('data-token')); break;
      case 'cancel-yes': doCancel(el.getAttribute('data-token'), el); break;
      case 'restore': doRestore(el.getAttribute('data-token'), el); break;
      case 'resched': startResched(el.getAttribute('data-token')); break;
      case 'resched-abort': stopResched(); break;
      case 'resched-confirm': confirmResched(el); break;
      case 'gcal': { var c1 = calendarData(el.getAttribute('data-token')); if (c1) openExternal(googleCalendarUrl(c1)); break; }
      case 'ics': { var c2 = calendarData(el.getAttribute('data-token')); if (c2) downloadIcs(c2); break; }
      case 'open': openExternal(el.getAttribute('data-url')); break;
      case 'install':
        if (S.installEvt) { S.installEvt.prompt(); S.installEvt = null; render(); }
        break;
      case 'forget':
        store.del(K.client); store.del(K.draft); store.del(K.bookings);
        S.client = null; S.bookings = [];
        render();
        toast('Готово: имя, телефон и список записей на этом устройстве удалены. Сами записи у мастера остались.');
        break;
      default: break;
    }
  }
  var draftTimer = null;
  function onInput(e) {
    var form = e.target.form;
    if (!form || form.id !== 'book-form') return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      var d = {};
      Array.prototype.forEach.call(form.elements, function (el) { if (el.name) d[el.name] = el.value; });
      store.set(K.draft, d);
    }, 400);
  }
  function onSubmit(e) {
    if (e.target.id !== 'book-form') return;
    e.preventDefault();
    submitBooking(e.target);
  }
  function onKey(e) {
    if (e.key === 'Escape' && S.overlay && !S.overlay.busy) closeOverlay();
  }

  // ------------------------------------------------------------------ запуск
  function fatal(msg) {
    root.innerHTML = '<div class="fatal"><h1>Запись временно недоступна</h1><p>' + esc(msg) + '</p></div>';
  }
  function init() {
    var problem = versionProblem();
    if (problem) { fatal(problem); return Promise.resolve(); }
    if (tg) {
      try {
        tg.ready(); tg.expand();
        document.documentElement.setAttribute('data-theme', tg.colorScheme === 'dark' ? 'dark' : 'light');
        if (tg.onEvent) tg.onEvent('themeChanged', function () { document.documentElement.setAttribute('data-theme', tg.colorScheme === 'dark' ? 'dark' : 'light'); });
        if (tg.BackButton && tg.BackButton.onClick) tg.BackButton.onClick(function () { if (S.overlay && !S.overlay.busy) closeOverlay(); });
      } catch (e) { /* старый клиент Telegram */ }
    }
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('submit', onSubmit);
    document.addEventListener('keydown', onKey);
    window.addEventListener('online', renderOffline);
    window.addEventListener('offline', renderOffline);
    window.addEventListener('beforeinstallprompt', function (ev) { ev.preventDefault(); S.installEvt = ev; if (S.tab === 'info') render(); });
    if ('serviceWorker' in navigator && location.protocol === 'https:' && !tg) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* без офлайна — не критично */ });
    }
    if (S.info) { setTz(S.info.timezone); buildOrder(); }
    renderShell();
    render();
    return loadInfo().then(function () {
      render();
      if (S.bookings.length) refreshMine(true);
      return loadAll();
    }).catch(function (e) {
      if (!S.info) fatal(e.code === 'NETWORK' ? 'Нет связи с сервером. Проверьте интернет и обновите страницу.' : (e.message || 'Сервер недоступен'));
      else toast('Сервер недоступен — показаны сохранённые данные.', { error: true });
    });
  }

  function versionProblem() {
    var meta = document.querySelector('meta[name="mb-app-major"]');
    var htmlMajor = meta ? parseInt(meta.getAttribute('content'), 10) : NaN;
    if (htmlMajor !== APP_MAJOR) return 'index.html рассчитан на версию ' + htmlMajor + ', а загружен app_v' + APP_MAJOR + '.js. Обновите файлы сайта целиком.';
    if (CFG.APP_MAJOR !== APP_MAJOR) return 'config.js рассчитан на версию ' + CFG.APP_MAJOR + ', а приложение — версии ' + APP_MAJOR + '.';
    if (!CFG.API_URL) return 'В config.js не указан API_URL.';
    return '';
  }

  window.MB_APP = { version: APP_VERSION, ready: init(), state: S };
})();
