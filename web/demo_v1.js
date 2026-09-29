/* demo_v1.js — VERSION 1.0 (29.09.2026)
 * Демо-сервер витрины: тот же контракт, что у Apps Script, но в памяти браузера.
 * Работает, только если в config.js API_URL: 'demo'. Подключается из index.html всегда — он маленький.
 *
 * Контракт повторяет сервер: 50_Public.gs (availability.get, booking.create), 51_Manage.gs (booking.cancel,
 * booking.reschedule), 52_Portal.gs v1.0 (public.info, client.bookings) и решение В-6 для booking.restore
 * (30 минут с момента отмены). Ответ — { ok: true, data } или { ok: false, error: { code, message, retryable } }.
 *
 * Состояние хранится в localStorage (mb_demo_v1), чтобы «Мои записи» переживали перезагрузку.
 * Сброс демо: MB_DEMO_API.reset(). Задержка ответа: window.MB_DEMO_LATENCY (мс), по умолчанию 250–600.
 */
(function () {
  'use strict';

  var DEMO_MAJOR = 1;
  var KEY = 'mb_demo_v1';
  var OFFSET_MIN = 180;             // Europe/Moscow: +03:00 круглый год
  var OFFSET = '+03:00';
  var GRID = 30;
  var R = {
    min_slots: 2, max_slots: 8, horizon_days: 30, lead_time_min: 120,
    cancel_deadline_hours: 4, restore_window_min: 30, max_active: 3
  };
  // weekday: 1 = пн … 7 = вс; [начало, конец] в минутах от полуночи
  var SCHEDULE = { 1: [600, 1200], 2: [600, 1200], 3: [600, 1200], 4: [600, 1200], 5: [600, 1200], 6: [660, 1020] };
  var SERVICE = { service_id: 'svc_massage', title: 'Массаж' };

  // ---------------------------------------------------------------- время
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localParts(ms) {
    var d = new Date(ms + OFFSET_MIN * 60000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  function dateKey(ms) { var p = localParts(ms); return p.y + '-' + pad(p.m) + '-' + pad(p.d); }
  function msOf(key, minutes) {
    var a = key.split('-');
    return Date.UTC(+a[0], +a[1] - 1, +a[2]) + (minutes - OFFSET_MIN) * 60000;
  }
  function iso(ms) {
    var p = localParts(ms);
    return p.y + '-' + pad(p.m) + '-' + pad(p.d) + 'T' + pad(Math.floor(p.min / 60)) + ':' + pad(p.min % 60) + ':00' + OFFSET;
  }
  function addDays(key, n) { return dateKey(msOf(key, 12 * 60) + n * 86400000); }
  function weekday(key) { var a = key.split('-'); var w = new Date(Date.UTC(+a[0], +a[1] - 1, +a[2])).getUTCDay(); return w === 0 ? 7 : w; }
  function parseIso(s) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/.test(String(s || ''))) return NaN;
    return Date.parse(s);
  }

  // ---------------------------------------------------------------- состояние
  var mem = null;
  function load() {
    if (mem) return mem;
    try { mem = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { mem = null; }
    if (!mem || mem.v !== DEMO_MAJOR) mem = { v: DEMO_MAJOR, bookings: [], clients: [], requests: {} };
    return mem;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch (e) { /* приватный режим */ } }
  function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // «Чужие» записи: детерминированно от даты, чтобы день выглядел живым и не менялся от перезагрузки.
  function seedBusy(key) {
    var h = 2166136261;                                     // FNV-1a + перемешивание: соседние даты не похожи
    for (var i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h = (h ^ (h >>> 16)) >>> 0; h = Math.imul(h, 0x45d9f3b) >>> 0; h = (h ^ (h >>> 16)) >>> 0;
    var win = SCHEDULE[weekday(key)];
    if (!win) return [];
    if (h % 11 === 0) return [[win[0], win[1]]];            // иногда день занят целиком
    var out = [];
    var n = 1 + h % 3;                                      // 1–3 чужие записи
    for (var k = 0; k < n; k++) {
      var len = (2 + ((h >>> (4 + k * 5)) % 3)) * GRID;     // 1–2 часа
      var slots = Math.floor((win[1] - win[0] - len) / GRID);
      var st = win[0] + ((h >>> (9 + k * 7)) % (slots + 1)) * GRID;
      out.push([st, st + len]);
    }
    return out;
  }

  function busyFor(key, exceptId) {
    var b = seedBusy(key).map(function (x) { return [msOf(key, x[0]), msOf(key, x[1])]; });
    load().bookings.forEach(function (x) {
      if (x.booking_id === exceptId || x.status !== 'confirmed') return;
      if (dateKey(Date.parse(x.start_at)) !== key) return;
      b.push([Date.parse(x.start_at), Date.parse(x.end_at)]);
    });
    return b;
  }

  function slotsFor(key, durMin, exceptId) {
    var win = SCHEDULE[weekday(key)];
    if (!win) return [];
    var today = dateKey(Date.now());
    if (key < today || key > addDays(today, R.horizon_days)) return [];
    var busy = busyFor(key, exceptId);
    var earliest = Date.now() + R.lead_time_min * 60000;
    var out = [];
    for (var m = win[0]; m + durMin <= win[1]; m += GRID) {
      var s = msOf(key, m), e = s + durMin * 60000;
      if (s < earliest) continue;
      var clash = busy.some(function (x) { return s < x[1] && e > x[0]; });
      if (!clash) out.push({ start: iso(s), end: iso(e) });
    }
    return out;
  }

  // ---------------------------------------------------------------- токены и представления
  function tokenOf(b) { return b.booking_id + '.' + Math.floor(Date.parse(b.start_at) / 1000 + 30 * 86400) + '.demo' + b.ver; }
  function manageUrl(b) { return 'https://demo.invalid/exec?r=manage&t=' + encodeURIComponent(tokenOf(b)); }
  function byToken(t) {
    var p = String(t || '').split('.');
    if (p.length !== 3) throw err('UNAUTHORIZED', 'Ссылка недействительна');
    var b = load().bookings.filter(function (x) { return x.booking_id === p[0]; })[0];
    if (!b) throw err('NOT_FOUND', 'Запись не найдена');
    if (p[2] !== 'demo' + b.ver) throw err('UNAUTHORIZED', 'Ссылка недействительна');
    return b;
  }
  function publicOf(b) {
    return {
      booking_id: b.booking_id, start_at: b.start_at, end_at: b.end_at,
      service_title: SERVICE.title, service_id: SERVICE.service_id,
      duration_min: Math.round((Date.parse(b.end_at) - Date.parse(b.start_at)) / 60000),
      status: b.status, comment: b.comment || '', manage_url: manageUrl(b)
    };
  }
  function restoreUntil(b) {
    if (b.status !== 'cancelled_by_client' || !b.cancelled_at) return 0;
    return Date.parse(b.cancelled_at) + R.restore_window_min * 60000;
  }
  function viewOf(b) {
    var start = Date.parse(b.start_at), now = Date.now(), dl = R.cancel_deadline_hours * 3600000;
    var ru = restoreUntil(b);
    return {
      booking_id: b.booking_id, token: tokenOf(b), start_at: b.start_at, end_at: b.end_at,
      duration_min: Math.round((Date.parse(b.end_at) - start) / 60000),
      status: b.status, comment: b.comment || '', is_past: start <= now,
      can_cancel: b.status === 'confirmed' && start - now > dl,
      can_reschedule: b.status === 'confirmed' && start - now > dl,
      can_restore: !!ru && ru > now && start - now > dl,
      restore_until: ru ? iso(ru) : '',
      after_booking: b.status === 'confirmed' && start > now ? 'Код домофона — 12К3456 (пример), дверь направо от лифта.' : ''
    };
  }
  function assertDeadline(b) {
    if (Date.parse(b.start_at) - Date.now() < R.cancel_deadline_hours * 3600000) {
      throw err('TOO_LATE', 'Отмена возможна не позднее чем за ' + R.cancel_deadline_hours + ' ч. Позвоните мастеру');
    }
  }
  function normPhone(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
    if (d.length === 10) d = '7' + d;
    return d.length === 11 && d[0] === '7' ? '+' + d : '';
  }

  // ---------------------------------------------------------------- обработчики
  function err(code, message) { var e = new Error(message); e.code = code; return e; }

  var H = {
    'public.info': function () {
      return {
        master_name: 'Мария',
        master_about: 'Классический и расслабляющий массаж. Здесь будет пара слов от мастера — это демо.',
        master_phone: '',
        studio_address: 'ул. Примерная, 1 — адрес для примера',
        studio_directions: 'Второй подъезд, 4 этаж.',
        studio_bring: 'Ничего не нужно: полотенца и масло есть. Можно взять удобную одежду.',
        bot_username: '', address_form: 'vy', timezone: 'Europe/Moscow', grid_min: GRID,
        min_slots: R.min_slots, max_slots: R.max_slots, horizon_days: R.horizon_days,
        lead_time_min: R.lead_time_min, cancel_deadline_hours: R.cancel_deadline_hours,
        restore_window_min: R.restore_window_min, services: [SERVICE]
      };
    },

    'availability.get': function (q) {
      var p = q.payload || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date_from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(p.date_to || '')) throw err('BAD_SLOT', 'Некорректный диапазон дат');
      var dur = parseInt(p.duration_min, 10) || 60;
      var days = [];
      for (var k = p.date_from, i = 0; k <= p.date_to; k = addDays(k, 1), i++) {
        if (i > 14) throw err('BAD_SLOT', 'Диапазон дат не должен превышать 14 дней');
        days.push({ date: k, slots: slotsFor(k, dur) });
      }
      return { timezone: 'Europe/Moscow', grid_min: GRID, days: days };
    },

    'booking.create': function (q) {
      var p = q.payload || {}, st = load();
      if (!q.request_id) throw err('BAD_REQUEST', 'Отсутствует request_id');
      var prev = st.requests[q.request_id];
      if (prev) {
        var b0 = st.bookings.filter(function (x) { return x.booking_id === prev; })[0];
        var c0 = st.clients.filter(function (x) { return x.client_id === b0.client_id; })[0];
        var o0 = publicOf(b0); o0.client_echo = { client_id: c0.client_id, name: c0.name, phone: c0.phone };
        return o0;
      }
      if (p.service_id !== SERVICE.service_id) throw err('BAD_SERVICE', 'Услуга недоступна');
      var start = parseIso(p.start_at);
      if (isNaN(start)) throw err('BAD_SLOT', 'Время должно быть в ISO-8601 с офсетом');
      if (localParts(start).min % GRID) throw err('BAD_SLOT', 'Начало должно попадать на сетку 30 минут');
      var slots = parseInt(p.slots_count, 10) || R.min_slots;
      if (slots < R.min_slots) throw err('BAD_SLOT', 'Минимум ' + R.min_slots + ' слота подряд');
      if (slots > R.max_slots) throw err('BAD_SLOT', 'Максимум ' + R.max_slots + ' слотов за одну запись');
      var dur = slots * GRID;
      var free = slotsFor(dateKey(start), dur).some(function (s) { return s.start === iso(start); });
      if (!free) throw err('SLOT_TAKEN', 'Это время только что заняли. Выберите другое');

      var c = p.client || {};
      var phone = normPhone(c.phone);
      if (!phone) throw err('BAD_PHONE', 'Нужен номер из 10 цифр после +7');
      var name = String(c.name || '').trim().slice(0, 60);
      if (name.length < 2) throw err('BAD_REQUEST', 'Укажите имя');
      var client = st.clients.filter(function (x) { return x.phone === phone; })[0];
      if (!client) { client = { client_id: uid('c_'), name: name, phone: phone }; st.clients.push(client); }
      else client.name = name;
      var active = st.bookings.filter(function (x) {
        return x.client_id === client.client_id && x.status === 'confirmed' && Date.parse(x.end_at) > Date.now();
      }).length;
      if (active >= R.max_active) throw err('BAD_REQUEST', 'У вас уже есть ' + R.max_active + ' активные записи. Отмените одну из них');

      var b = {
        booking_id: uid('b_'), client_id: client.client_id, ver: 1,
        start_at: iso(start), end_at: iso(start + dur * 60000), status: 'confirmed',
        comment: String(p.comment || '').slice(0, 500), source: p.source || 'web', cancelled_at: ''
      };
      st.bookings.push(b);
      st.requests[q.request_id] = b.booking_id;
      save();
      var out = publicOf(b);
      out.client_echo = { client_id: client.client_id, name: client.name, phone: client.phone };
      return out;
    },

    'client.bookings': function (q) {
      var items = [], invalid = [];
      ((q.payload || {}).tokens || []).slice(0, 20).forEach(function (t) {
        try { items.push(viewOf(byToken(t))); } catch (e) { invalid.push({ token: String(t), code: e.code || 'INTERNAL' }); }
      });
      items.sort(function (a, b) { return a.start_at < b.start_at ? -1 : 1; });
      return { items: items, invalid: invalid, now: iso(Date.now()) };
    },

    'booking.cancel': function (q) {
      var b = byToken(q.auth && q.auth.token);
      if (b.status !== 'confirmed') throw err('NOT_FOUND', 'Запись уже отменена');
      assertDeadline(b);
      b.status = 'cancelled_by_client'; b.cancelled_at = new Date().toISOString();
      save();
      return { booking_id: b.booking_id, status: b.status };
    },

    'booking.reschedule': function (q) {
      var b = byToken(q.auth && q.auth.token);
      if (b.status !== 'confirmed') throw err('NOT_FOUND', 'Запись уже отменена');
      assertDeadline(b);
      var dur = Math.round((Date.parse(b.end_at) - Date.parse(b.start_at)) / 60000);
      var start = parseIso((q.payload || {}).start_at);
      if (isNaN(start) || localParts(start).min % GRID) throw err('BAD_SLOT', 'Начало должно попадать на сетку 30 минут');
      var free = slotsFor(dateKey(start), dur, b.booking_id).some(function (s) { return s.start === iso(start); });
      if (!free) throw err('SLOT_TAKEN', 'Этот слот только что заняли. Выберите другое время');
      b.start_at = iso(start); b.end_at = iso(start + dur * 60000); b.ver += 1;
      save();
      return publicOf(b);
    },

    'booking.restore': function (q) {
      var b = byToken(q.auth && q.auth.token);
      if (b.status === 'confirmed') return publicOf(b);
      var ru = restoreUntil(b);
      if (!ru || ru < Date.now()) throw err('TOO_LATE', 'Вернуть запись можно в течение ' + R.restore_window_min + ' минут после отмены');
      assertDeadline(b);
      var dur = Math.round((Date.parse(b.end_at) - Date.parse(b.start_at)) / 60000);
      var free = slotsFor(dateKey(Date.parse(b.start_at)), dur, b.booking_id).some(function (s) { return s.start === b.start_at; });
      if (!free) throw err('SLOT_TAKEN', 'Это время уже заняли');
      b.status = 'confirmed'; b.cancelled_at = '';
      save();
      return publicOf(b);
    }
  };

  function retryable(code) { return code === 'SLOT_TAKEN' || code === 'BUSY' || code === 'INTERNAL'; }

  function demoApi(req) {
    var lat = typeof window.MB_DEMO_LATENCY === 'number' ? window.MB_DEMO_LATENCY : 250 + Math.random() * 350;
    return new Promise(function (resolve) {
      setTimeout(function () {
        var h = H[req && req.action];
        if (!h) { resolve({ ok: false, error: { code: 'UNKNOWN_ACTION', message: String(req && req.action), retryable: false } }); return; }
        try {
          // клон — чтобы приложение не могло поменять «серверные» данные по ссылке
          resolve(JSON.parse(JSON.stringify({ ok: true, data: h(req) })));
        } catch (e) {
          var code = e.code || 'INTERNAL';
          resolve({ ok: false, error: { code: code, message: e.message, retryable: retryable(code) } });
        }
      }, lat);
    });
  }
  demoApi.major = DEMO_MAJOR;
  demoApi.reset = function () { mem = null; try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } };
  demoApi._occupy = function (startIso, endIso) {   // для тестов: «кто-то другой» занял время
    var st = load();
    st.bookings.push({ booking_id: uid('x_'), client_id: 'other', ver: 1, start_at: startIso, end_at: endIso, status: 'confirmed', comment: '', cancelled_at: '' });
    save();
  };
  window.MB_DEMO_API = demoApi;
})();
