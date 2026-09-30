/**
 * 52_AdminBookings.gs — VERSION = "1.1" (этап 15.1; 1.1 — перенос сбрасывает отметки напоминаний, этап 15.3)
 * Мастер записывает клиента сам, переносит запись, отмечает «пришёл / не пришёл», ищет клиента.
 *
 * Файл назван 52_*, а не 55_*: GAS грузит файлы по имени, и ROUTES в 53_Router.gs ссылается на
 * эти функции при загрузке — функции обязаны быть определены раньше роутера.
 *
 * Правила мастера отличаются от клиентских сознательно:
 *   - lead_time_min и min_slots_per_booking не действуют — мастер может записать «через 15 минут» и на 30 минут;
 *   - пересечение с другой записью запрещено всегда (SLOT_TAKEN);
 *   - вне графика / поверх блокировки / поверх личного события / в прошлом — только с подтверждением (CONFLICT → force).
 */

var ADMIN_BK_STATUSES_VISIBLE = ['confirmed', 'completed', 'no_show'];

/** Проверка интервала для мастера. @return {{hard: Array, soft: Array}} */
function AdminBk_check_(start, end, excludeId) {
  var hard = [], soft = [];
  var dayFrom = addDays(start, -1), dayTo = addDays(end, 1);

  Bookings_activeForRange(dayFrom, dayTo, true).forEach(function (b) {
    if (b.booking_id === excludeId) return;
    var bs = parseIsoStrict(b.start_at), be = parseIsoStrict(b.end_at);
    var c = Clients_get(b.client_id);
    var who = (c ? c.name : 'клиент') + ' ' + fmtHM(bs) + '–' + fmtHM(be);
    if (overlaps(start, end, bs, be)) { hard.push({ kind: 'booking', booking_id: b.booking_id, text: 'запись: ' + who }); return; }
    var buf = CFG_INT('buffer_after_min');
    if (buf > 0) {
      if (overlaps(start, end, be, addMin(be, buf))) soft.push({ kind: 'buffer', text: 'перерыв после записи: ' + who });
      if (overlaps(bs, be, end, addMin(end, buf))) soft.push({ kind: 'buffer', text: 'нет перерыва перед записью: ' + who });
    }
  });

  Blocks_forRange(start, end).forEach(function (bl) {
    soft.push({ kind: 'block', text: 'блокировка: ' + (bl.reason || 'занято') + ' ' + fmtHM(parseIsoStrict(bl.start_at)) + '–' + fmtHM(parseIsoStrict(bl.end_at)) });
  });
  BusyEvents_forRange(start, end).forEach(function (ev) {
    soft.push({ kind: 'external', text: 'личное событие: ' + (ev.title_masked || 'занято') });
  });

  var inWindow = Schedule_windowsFor(dateOf(start)).some(function (w) {
    return toDate(dateOf(start), w.start) <= start && end <= toDate(dateOf(start), w.end);
  });
  if (!inWindow) soft.push({ kind: 'schedule', text: 'вне рабочего графика' });
  if (start < new Date()) soft.push({ kind: 'past', text: 'время уже прошло' });

  return { hard: hard, soft: soft };
}

/** Интервал из payload: start_at + slots_count × 30. */
function AdminBk_interval_(p) {
  var start = parseIsoStrict(p.start_at);
  if (!isOnGrid(start, GRID_MIN)) throw apiError('BAD_SLOT', 'Начало должно попадать на сетку 30 минут');
  var maxSlots = parseInt(CFG_opt('max_slots_per_booking', '8'), 10);
  var slots = parseInt(p.slots_count, 10);
  if (!(slots >= 1 && slots <= maxSlots)) throw apiError('BAD_SLOT', 'Длительность — от 1 до ' + maxSlots + ' слотов по 30 минут');
  return { start: start, end: addMin(start, slots * GRID_MIN), slots: slots };
}

/** Результат проверки → исключение или null. */
function AdminBk_guard_(chk, force) {
  if (chk.hard.length) {
    throw apiError('SLOT_TAKEN', 'Это время уже занято — ' + chk.hard.map(function (x) { return x.text; }).join('; '));
  }
  if (chk.soft.length && force !== true) {
    return { ok: false, error: { code: 'CONFLICT', message: 'Нужно подтверждение', retryable: false }, warnings: chk.soft };
  }
  return null;
}

/** Клиент для записи мастером: поиск по телефону, иначе создание. Бан (is_blocked) мастер не проверяет — решение за ней. */
function AdminBk_client_(p) {
  var c = p.client || {};
  if (c.client_id) {
    var byId = Clients_get(String(c.client_id));
    if (byId) return AdminBk_touchClient_(byId, c.name);
  }
  var name = String(c.name || '').trim();
  if (name.length < 2) throw apiError('BAD_REQUEST', 'Укажите имя клиента');
  var phone = Phone_normalize(c.phone);
  var found = Clients_findByPhone(phone);
  if (found) return AdminBk_touchClient_(found, name);
  var row = {
    client_id: Utils_uuid(), phone: phone, name: name.slice(0, 60),
    identity_provider: 'admin', identity_ref: '', tg_chat_id: '', consent_at: nowIso(),
    first_seen_at: nowIso(), last_seen_at: nowIso(), bookings_count: 1, is_blocked: 'FALSE'
  };
  Sheet_append('clients', row);
  return row;
}

function AdminBk_touchClient_(found, name) {
  var nm = String(name || '').trim();
  var patch = { last_seen_at: nowIso(), bookings_count: parseInt(found.bookings_count || 0, 10) + 1 };
  if (nm.length >= 2 && nm !== found.name) patch.name = nm.slice(0, 60);
  Sheet_update('clients', 'client_id', found.client_id, patch);
  if (patch.name) found.name = patch.name;
  return found;
}

function AdminBk_defaultService_() {
  var id = CFG_opt('assistant_default_service', '');
  var svc = id ? Services_get(id) : null;
  if (svc) return svc;
  var list = Services_list(true);
  if (!list.length) throw apiError('BAD_SERVICE', 'Нет активных услуг — добавьте строку в лист services');
  return list[0];
}

function AdminBk_lock_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw apiError('BUSY', 'Сервис занят, повторите через несколько секунд');
  return lock;
}

/** admin.bookingCreate — payload {start_at, slots_count, client:{client_id?|name, phone}, comment, force} */
function Api_adminBookingCreate(req) {
  Admin_auth_(req);
  var p = req.payload || {};
  var lock = AdminBk_lock_();
  try {
    if (req.request_id) {
      var existing = Bookings_findByRequestId(req.request_id);
      if (existing) return { ok: true, data: Bookings_toPublic(existing), idempotent_replay: true };
    }
    var iv = AdminBk_interval_(p);
    var stop = AdminBk_guard_(AdminBk_check_(iv.start, iv.end, null), p.force);
    if (stop) return stop;

    var client = AdminBk_client_(p);
    var svc = AdminBk_defaultService_();
    var b = Bookings_insert({
      booking_id: Utils_uuid(),
      request_id: req.request_id || Utils_uuid(),
      client_id: client.client_id,
      service_id: svc.service_id,
      start_at: iso(iv.start),
      end_at: iso(iv.end),
      status: 'confirmed',
      comment: String(p.comment || '').slice(0, 500),
      source: 'admin',
      calendar_sync_status: 'pending',
      gcal_event_id: '',
      created_at: nowIso()
    });
    var out = Bookings_toPublic(b);
    out.client = { client_id: client.client_id, name: client.name, phone: client.phone };
    return { ok: true, data: out };
  } finally {
    lock.releaseLock();
  }
}

/** admin.bookingMove — payload {booking_id, start_at, slots_count, force}. Ссылка клиента на отмену остаётся рабочей. */
function Api_adminBookingMove(req) {
  Admin_auth_(req);
  var p = req.payload || {};
  var lock = AdminBk_lock_();
  try {
    var b = Bookings_get(p.booking_id);
    if (!b) throw apiError('NOT_FOUND', 'Запись не найдена');
    if (b.status !== 'confirmed') throw apiError('BAD_REQUEST', 'Переносить можно только активную запись');
    if (!p.slots_count) {
      p.slots_count = Math.round((parseIsoStrict(b.end_at) - parseIsoStrict(b.start_at)) / (GRID_MIN * 60000));
    }
    var iv = AdminBk_interval_(p);
    var stop = AdminBk_guard_(AdminBk_check_(iv.start, iv.end, b.booking_id), p.force);
    if (stop) return stop;

    Bookings_update(b.booking_id, {
      start_at: iso(iv.start), end_at: iso(iv.end),
      calendar_sync_status: 'pending', calendar_sync_attempts: 0, next_retry_at: '', calendar_last_error: '',
      reminder_24_at: '', reminder_2_at: ''   // этап 15.3: напоминания — заново, по новому времени
    });
    return { ok: true, data: Bookings_toPublic(Bookings_get(b.booking_id)) };
  } finally {
    lock.releaseLock();
  }
}

/** admin.bookingMark — payload {booking_id, status: completed | no_show | confirmed}. Только для начавшихся записей. */
function Api_adminBookingMark(req) {
  Admin_auth_(req);
  var p = req.payload || {};
  var to = String(p.status || '');
  if (['completed', 'no_show', 'confirmed'].indexOf(to) < 0) throw apiError('BAD_REQUEST', 'Недопустимый статус');
  var b = Bookings_get(p.booking_id);
  if (!b) throw apiError('NOT_FOUND', 'Запись не найдена');
  if (ADMIN_BK_STATUSES_VISIBLE.indexOf(b.status) < 0) throw apiError('BAD_REQUEST', 'Запись отменена — отметка недоступна');
  if (parseIsoStrict(b.start_at) > new Date()) throw apiError('TOO_EARLY', 'Отметить можно, когда запись началась');
  Bookings_update(b.booking_id, { status: to });
  return { ok: true, data: { booking_id: b.booking_id, status: to } };
}

/** admin.clientsFind — payload {q}. До 8 клиентов по имени или цифрам телефона; свежие визиты выше. */
function Api_adminClientsFind(req) {
  Admin_auth_(req);
  var q = String((req.payload || {}).q || '').trim().toLowerCase();
  if (q.length < 2) return { ok: true, data: { clients: [] } };
  var digits = q.replace(/\D/g, '');
  var last = {}, visits = {};
  Bookings_all(true).forEach(function (b) {
    if (b.status === 'completed' || b.status === 'confirmed' || b.status === 'no_show') {
      if (b.status === 'completed') visits[b.client_id] = (visits[b.client_id] || 0) + 1;
      if (!last[b.client_id] || b.start_at > last[b.client_id]) last[b.client_id] = b.start_at;
    }
  });
  var list = Clients_all().filter(function (c) {
    if (String(c.name) === 'Удалено') return false;
    var byName = String(c.name || '').toLowerCase().indexOf(q) >= 0;
    var byPhone = digits.length >= 3 && String(c.phone || '').replace(/\D/g, '').indexOf(digits) >= 0;
    return byName || byPhone;
  }).map(function (c) {
    return { client_id: c.client_id, name: c.name, phone: c.phone, last_at: last[c.client_id] || '', visits: visits[c.client_id] || 0 };
  }).sort(function (a, b) { return a.last_at < b.last_at ? 1 : -1; }).slice(0, 8);
  return { ok: true, data: { clients: list } };
}
