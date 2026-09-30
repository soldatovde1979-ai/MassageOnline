/**
 * 52_Portal.gs — VERSION 1.0 (29.09.2026, этап 15.2)
 * Серверная часть клиентской витрины (статический сайт + Telegram Mini App):
 *   public.info     — визитка мастера и правила записи, без авторизации;
 *   client.bookings — «Мои записи»: свежий статус записей по ссылкам управления с устройства клиента.
 *
 * Файл назван 52_*, чтобы грузиться раньше 53_Router.gs: ROUTES ссылается на эти функции при загрузке.
 * Новые ключи config не требуют правки 61_Bootstrap.gs — их добавляет setupPortal().
 */

var PORTAL_CONFIG_DEFAULTS = [
  ['master_name', ''],          // как подписать мастера на витрине: «Мария»
  ['master_about', ''],         // 1–2 фразы о себе
  ['master_phone', ''],         // показывается клиентам, если заполнен
  ['studio_address', ''],       // адрес без кода домофона
  ['studio_directions', ''],    // как пройти; код домофона — только после записи (studio_after_booking)
  ['studio_bring', ''],         // что взять с собой
  ['studio_after_booking', ''], // показывается только на экране «Вы записаны»: код домофона, этаж
  ['max_bookings_per_day', '0'],// лимит сеансов в день, 0 — без лимита
  ['restore_window_min', '30'], // окно «Вернуть запись» после отмены (решение по В-6)
  ['client_address_form', 'vy'] // обращение к клиенту на витрине: vy — «вы», ty — «ты»
];

var PORTAL_MAX_TOKENS = 20;

/** Разовая настройка: дописывает недостающие ключи в лист config. Идемпотентна, ничего не перезаписывает. */
function setupPortal() {
  var cfg = CFG_all();
  var added = [];
  PORTAL_CONFIG_DEFAULTS.forEach(function (kv) {
    if (!(kv[0] in cfg)) { Sheet_append('config', { key: kv[0], value: kv[1] }); added.push(kv[0]); }
  });
  CFG_invalidate();
  var msg = added.length ? 'Добавлены ключи config: ' + added.join(', ') : 'Все ключи витрины уже есть';
  console.log(msg);
  return msg;
}

function Api_publicInfo() {
  var restoreAvailable = typeof Api_bookingRestore === 'function';
  return {
    ok: true,
    data: {
      master_name: CFG_opt('master_name', ''),
      master_about: CFG_opt('master_about', ''),
      master_phone: CFG_opt('master_phone', ''),
      studio_address: CFG_opt('studio_address', ''),
      studio_directions: CFG_opt('studio_directions', ''),
      studio_bring: CFG_opt('studio_bring', ''),
      bot_username: CFG_opt('client_bot_username', ''),
      address_form: CFG_opt('client_address_form', 'vy') === 'ty' ? 'ty' : 'vy',
      timezone: TZ(),
      grid_min: GRID_MIN,
      min_slots: parseInt(CFG_opt('min_slots_per_booking', '2'), 10),
      max_slots: parseInt(CFG_opt('max_slots_per_booking', '8'), 10),
      horizon_days: CFG_INT('horizon_days'),
      lead_time_min: CFG_INT('lead_time_min'),
      cancel_deadline_hours: CFG_INT('cancel_deadline_hours'),
      restore_window_min: restoreAvailable ? Portal_restoreWindowMin_() : 0,
      services: Services_list(true).map(function (s) { return { service_id: s.service_id, title: s.title }; })
    }
  };
}

/**
 * payload: { tokens: [manageToken, ...] } — до 20 штук, как хранятся на устройстве клиента.
 * Ответ: { items: [...], invalid: [token, ...] }. Недействительная ссылка — не ошибка запроса:
 * запись могли перенести с другого устройства (сменилась версия ссылки) или удалить.
 */
function Api_clientBookings(req) {
  var tokens = ((req.payload || {}).tokens || []).slice(0, PORTAL_MAX_TOKENS);
  var items = [], invalid = [];
  tokens.forEach(function (t) {
    try {
      var b = Security_verifyManageToken(t);
      items.push(Portal_view_(b));
    } catch (e) {
      invalid.push({ token: String(t), code: e.code || 'INTERNAL' });
    }
  });
  items.sort(function (a, b) { return a.start_at < b.start_at ? -1 : 1; });
  return { ok: true, data: { items: items, invalid: invalid, now: nowIso() } };
}

/** Представление записи для клиента: только его данные и то, что он может с ней сделать. */
function Portal_view_(b) {
  var start = Portal_time_(b.start_at), end = Portal_time_(b.end_at), now = Date.now();
  var deadlineMs = CFG_INT('cancel_deadline_hours') * 3600000;
  var restoreUntil = Portal_restoreUntil_(b);
  var inFuture = start > now;
  return {
    booking_id: b.booking_id,
    token: Security_buildManageToken(b),
    start_at: iso(new Date(start)),
    end_at: iso(new Date(end)),
    duration_min: Math.round((end - start) / 60000),
    status: b.status,
    comment: b.comment || '',
    is_past: !inFuture,
    can_cancel: b.status === 'confirmed' && (start - now) > deadlineMs,
    can_reschedule: b.status === 'confirmed' && (start - now) > deadlineMs,
    can_restore: !!restoreUntil && restoreUntil > now && (start - now) > deadlineMs &&
      typeof Api_bookingRestore === 'function',
    restore_until: restoreUntil ? iso(new Date(restoreUntil)) : '',
    after_booking: b.status === 'confirmed' && inFuture ? CFG_opt('studio_after_booking', '') : ''
  };
}

function Portal_restoreWindowMin_() {
  return parseInt(CFG_opt('restore_window_min', '30'), 10) || 0;
}

/** Момент, до которого клиент может вернуть отменённую запись (мс), или 0. */
function Portal_restoreUntil_(b) {
  if (b.status !== 'cancelled_by_client') return 0;
  var reason = String(b.cancel_reason || '');
  if (reason === 'calendar_delete' || reason === 'gdpr_forget' || reason === 'reschedule') return 0;
  var at = Portal_time_(b.cancelled_at);
  if (!at) return 0;
  return at + Portal_restoreWindowMin_() * 60000;
}

/** Ячейка времени из Sheets: ISO-строка или Date (реальные Sheets превращают ISO в Date). */
function Portal_time_(v) {
  if (!v) return 0;
  var d = v instanceof Date ? v : new Date(String(v));
  return isNaN(d.getTime()) ? 0 : d.getTime();
}
