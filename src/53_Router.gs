/**
 * 53_Router.gs — VERSION 1.4 (29.09.2026)
 * Точки входа. doGet отдаёт страницы, apiCall и doPost делят один диспетчер.
 *
 * 1.1 (этап 15.1): маршруты мастера admin.bookingCreate / bookingMove / bookingMark / clientsFind.
 * 1.2 (этап 15.2): public.info и client.bookings для витрины; маршрут booking.restore и вебхук бота
 *     (этап 14) подключены ЛЕНИВО — 54_Restore.gs и 71_TelegramClient.gs грузятся ПОСЛЕ роутера,
 *     прямая ссылка на их функции в ROUTES роняла бы проект при загрузке (ревью, п. 1.3).
 *     Если файлов этапа 14 нет, маршруты отвечают UNKNOWN_ACTION, а не падают.
 * 1.3 (этап 15.4): карточка клиента — admin.clientGet / admin.clientUpdate.
 * 1.4 (этап 15.5): правила записи — admin.rulesGet / admin.rulesSet.
 */

var ROUTES = {
  'services.list': Api_servicesList,
  'availability.get': Api_availabilityGet,
  'booking.create': Api_bookingCreate,
  'booking.get': Api_bookingGet,
  'booking.cancel': Api_bookingCancel,
  'booking.reschedule': Api_bookingReschedule,
  'booking.restore': Router_restore_,
  'public.info': Api_publicInfo,
  'client.bookings': Api_clientBookings,
  'admin.login': Api_adminLogin,
  'admin.agenda': Api_adminAgenda,
  'admin.blockCreate': Api_adminBlockCreate,
  'admin.blockDelete': Api_adminBlockDelete,
  'admin.scheduleGet': Api_adminScheduleGet,
  'admin.scheduleSet': Api_adminScheduleSet,
  'admin.bookingCancel': Api_adminBookingCancel,
  'admin.bookingCreate': Api_adminBookingCreate,
  'admin.bookingMove': Api_adminBookingMove,
  'admin.bookingMark': Api_adminBookingMark,
  'admin.clientsFind': Api_adminClientsFind,
  'admin.clientGet': Api_adminClientGet,
  'admin.clientUpdate': Api_adminClientUpdate,
  'admin.rulesGet': Api_adminRulesGet,
  'admin.rulesSet': Api_adminRulesSet
};

/**
 * booking.restore живёт в 54_Restore.gs (этап 14), который грузится после роутера.
 * Имя ищется в момент вызова: typeof для необъявленного имени не бросает исключение.
 * Объявление функции поднимается внутри файла, поэтому ROUTES может на неё ссылаться.
 */
function Router_restore_(req) {
  if (typeof Api_bookingRestore !== 'function') {
    throw apiError('UNKNOWN_ACTION', 'Возврат записи недоступен: не залит 54_Restore.gs');
  }
  return Api_bookingRestore(req);
}

function Api_dispatch(req) {
  var t0 = Date.now();
  var handler = ROUTES[req && req.action];
  if (!handler) return { ok: false, error: { code: 'UNKNOWN_ACTION', message: String(req && req.action), retryable: false } };
  try {
    var res = handler(req);
    Audit_log(req.action, 'OK', Date.now() - t0, '', '', Router_actor_(req));
    return res;
  } catch (err) {
    var code = err.code || 'INTERNAL';
    Audit_log(req.action, 'ERROR', Date.now() - t0, code, err.message, Router_actor_(req));
    return { ok: false, error: { code: code, message: err.message, retryable: Router_retryable_(code) } };
  }
}

function Router_retryable_(code) { return code === 'SLOT_TAKEN' || code === 'BUSY' || code === 'INTERNAL'; }

function Router_actor_(req) {
  if (String(req.action).indexOf('admin.') === 0) return 'admin';
  var id = req.payload && req.payload.client && req.payload.client.client_id;
  return id ? 'client:' + Mask_id(id) : 'client';
}

/** Вызов из HtmlService-страниц через google.script.run. */
function apiCall(json) {
  var req;
  try { req = JSON.parse(json); }
  catch (e) { return JSON.stringify({ ok: false, error: { code: 'BAD_JSON', message: 'Malformed request', retryable: false } }); }
  return JSON.stringify(Api_dispatch(req));
}

/** Внешний JSON-API: Telegram Mini App, интеграции. Content-Type: text/plain. */
/** Внешний JSON-API (витрина, Mini App) + вебхук клиентского бота (?r=tg&s=<секрет>, этап 14). */
function doPost(e) {
  var q = (e && e.parameter) || {};

  if (q.r === 'tg') {
    if (typeof TgClient_webhook !== 'function') return jsonOut({ ok: true });
    var upd;
    try { upd = JSON.parse(e.postData.contents); }
    catch (err) { return jsonOut({ ok: true }); }   // Telegram не должен ретраить мусор
    return jsonOut(TgClient_webhook(upd, q.s));
  }

  var req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return jsonOut({ ok: false, error: { code: 'BAD_JSON', message: 'Malformed request body', retryable: false } }); }
  return jsonOut(Api_dispatch(req));
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var r = (e && e.parameter && e.parameter.r) || '';
  var file = r === 'admin' ? 'admin' : r === 'manage' ? 'manage' : 'client';
  var t = HtmlService.createTemplateFromFile('ui/' + file);
  t.token = (e && e.parameter && e.parameter.t) || '';
  return t.evaluate()
    .setTitle('Запись на массаж')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(name) { return HtmlService.createHtmlOutputFromFile('ui/' + name).getContent(); }
