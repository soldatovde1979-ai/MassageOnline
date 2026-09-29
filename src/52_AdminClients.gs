/**
 * 52_AdminClients.gs — VERSION 1.0 (29.09.2026, этап 15.4)
 * Карточка клиента для мастера: история визитов и заметки («давление сильнее», «шея», противопоказания).
 *
 * Файл назван 52_*, а не 55_*: ROUTES в 53_Router.gs ссылается на эти функции при загрузке (ревью, п. 1.3).
 * Заметки хранятся в колонке clients.notes; на старой таблице колонку добавляет повторный setup().
 * Клиенту заметки не показываются никогда — только в admin.* маршрутах.
 */

var CLIENT_NOTES_MAX = 2000;
var CLIENT_HISTORY_MAX = 50;

/** Все брони клиента: текущие + архив. Свежие сверху. */
function AdminCl_history_(clientId) {
  var rows = Bookings_all(true).filter(function (b) { return b.client_id === clientId; });
  try {
    Sheet_readAll('bookings_archive').forEach(function (b) {
      if (b.client_id !== clientId) return;
      b.start_at = Bookings_isoCell_(b.start_at);
      b.end_at = Bookings_isoCell_(b.end_at);
      rows.push(b);
    });
  } catch (e) { /* листа архива нет на очень старой таблице — история без архива */ }
  return rows.sort(function (a, b) { return a.start_at < b.start_at ? 1 : -1; });
}

/** admin.clientGet — payload {client_id}. Карточка: клиент, заметки, счётчики, история. */
function Api_adminClientGet(req) {
  Admin_auth_(req);
  var c = Clients_get(String((req.payload || {}).client_id || ''));
  if (!c) throw apiError('NOT_FOUND', 'Клиент не найден');

  var now = new Date();
  var stats = { completed: 0, no_show: 0, cancelled: 0, upcoming: 0 };
  var lastVisit = '', nextVisit = '';
  var all = AdminCl_history_(c.client_id);
  all.forEach(function (b) {
    var start = parseIsoStrict(b.start_at);
    if (b.status === 'completed') {
      stats.completed++;
      if (!lastVisit || b.start_at > lastVisit) lastVisit = b.start_at;
    } else if (b.status === 'no_show') {
      stats.no_show++;
    } else if (String(b.status).indexOf('cancelled') === 0) {
      stats.cancelled++;
    } else if (b.status === 'confirmed' && start > now) {
      stats.upcoming++;
      if (!nextVisit || b.start_at < nextVisit) nextVisit = b.start_at;
    }
  });

  var history = all.slice(0, CLIENT_HISTORY_MAX).map(function (b) {
    return {
      booking_id: b.booking_id, start_at: b.start_at, end_at: b.end_at, status: b.status,
      source: b.source || 'web', comment: b.comment || ''
    };
  });

  return {
    ok: true,
    data: {
      client: {
        client_id: c.client_id, name: c.name, phone: c.phone, notes: String(c.notes || ''),
        first_seen_at: c.first_seen_at ? Bookings_isoCell_(c.first_seen_at) : '',
        is_blocked: String(c.is_blocked).toUpperCase() === 'TRUE'
      },
      stats: stats,
      last_visit_at: lastVisit,
      next_visit_at: nextVisit,
      history: history,
      history_total: all.length
    }
  };
}

/** admin.clientUpdate — payload {client_id, notes?, name?}. Меняет только переданные поля. */
function Api_adminClientUpdate(req) {
  Admin_auth_(req);
  var p = req.payload || {};
  var c = Clients_get(String(p.client_id || ''));
  if (!c) throw apiError('NOT_FOUND', 'Клиент не найден');
  if (Sheet_head('clients').indexOf('notes') < 0) {
    throw apiError('INTERNAL', 'В листе clients нет колонки notes. Выполните setup() ещё раз.');
  }
  var patch = {};
  if (p.notes !== undefined) patch.notes = String(p.notes || '').slice(0, CLIENT_NOTES_MAX);
  if (p.name !== undefined) {
    var nm = String(p.name || '').trim();
    if (nm.length < 2) throw apiError('BAD_REQUEST', 'Имя — минимум 2 символа');
    patch.name = nm.slice(0, 60);
  }
  if (!Object.keys(patch).length) throw apiError('BAD_REQUEST', 'Нечего сохранять');
  Sheet_update('clients', 'client_id', c.client_id, patch);
  return { ok: true, data: { client_id: c.client_id, notes: patch.notes !== undefined ? patch.notes : String(c.notes || ''), name: patch.name || c.name } };
}
