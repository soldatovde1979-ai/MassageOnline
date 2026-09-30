/**
 * 52_AdminStats.gs — VERSION 1.0 (30.09.2026, этап 15.6)
 * Экран «Мой месяц»: визиты, часы, постоянные и новые клиенты, лучший день, загрузка по дням недели.
 *
 * Визит — запись со статусом completed или confirmed, которая уже закончилась (dailyMaintenance
 * помечает такие completed только ночью). no_show и отмены визитами не считаются.
 * Файл назван 52_*: ROUTES в 53_Router.gs ссылается на эти функции при загрузке (ревью, п. 1.3).
 */

/** Все брони: текущие + архив. */
function AdminStats_all_() {
  var rows = Bookings_all(true).slice();
  try {
    Sheet_readAll('bookings_archive').forEach(function (b) {
      b.start_at = Bookings_isoCell_(b.start_at);
      b.end_at = Bookings_isoCell_(b.end_at);
      rows.push(b);
    });
  } catch (e) { /* листа архива нет — считаем без него */ }
  return rows;
}

function AdminStats_isVisit_(b, now) {
  return b.status === 'completed' || (b.status === 'confirmed' && parseIsoStrict(b.end_at) <= now);
}

/** 'ГГГГ-ММ' ± n месяцев. */
function AdminStats_shift_(ym, n) {
  var y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(5, 7), 10) - 1 + n;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y + '-' + ('0' + (m + 1)).slice(-2);
}

/** Сводка за месяц ym по уже прочитанным броням. */
function AdminStats_month_(all, ym, now) {
  var r = { visits: 0, minutes: 0, no_show: 0, cancelled: 0, upcoming: 0, clients: 0, new_clients: 0,
    by_weekday: [0, 0, 0, 0, 0, 0, 0], top_clients: [], best_day: null };
  var perClient = {}, perDay = {};
  all.forEach(function (b) {
    var start = parseIsoStrict(b.start_at);
    if (dateOf(start).slice(0, 7) !== ym) return;
    if (AdminStats_isVisit_(b, now)) {
      r.visits++;
      var min = Math.round((parseIsoStrict(b.end_at) - start) / 60000);
      r.minutes += min;
      r.by_weekday[parseInt(Utilities.formatDate(start, TZ(), 'u'), 10) - 1]++;
      perClient[b.client_id] = (perClient[b.client_id] || 0) + 1;
      var ds = dateOf(start);
      perDay[ds] = perDay[ds] || { date: ds, visits: 0, minutes: 0 };
      perDay[ds].visits++; perDay[ds].minutes += min;
    } else if (b.status === 'no_show') {
      r.no_show++;
    } else if (String(b.status).indexOf('cancelled') === 0) {
      r.cancelled++;
    } else if (b.status === 'confirmed') {
      r.upcoming++;
    }
  });

  // Новый клиент — первый визит за всю историю пришёлся на этот месяц.
  var firstVisit = {};
  all.forEach(function (b) {
    if (!AdminStats_isVisit_(b, now)) return;
    if (!firstVisit[b.client_id] || b.start_at < firstVisit[b.client_id]) firstVisit[b.client_id] = b.start_at;
  });
  var ids = Object.keys(perClient);
  r.clients = ids.length;
  r.new_clients = ids.filter(function (id) { return dateOf(parseIsoStrict(firstVisit[id])).slice(0, 7) === ym; }).length;

  r.top_clients = ids.filter(function (id) { return perClient[id] >= 2; })
    .sort(function (a, b) { return perClient[b] - perClient[a]; })
    .slice(0, 3)
    .map(function (id) {
      var c = Clients_get(id);
      return { client_id: id, name: c ? c.name : '(клиент удалён)', visits: perClient[id] };
    });

  Object.keys(perDay).forEach(function (ds) {
    var d = perDay[ds];
    if (!r.best_day || d.minutes > r.best_day.minutes || (d.minutes === r.best_day.minutes && ds < r.best_day.date)) r.best_day = d;
  });
  return r;
}

/** admin.stats — payload {month: 'ГГГГ-ММ'} (по умолчанию текущий). */
function Api_adminStats(req) {
  Admin_auth_(req);
  var now = new Date();
  var ym = String((req.payload || {}).month || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) ym = dateOf(now).slice(0, 7);
  var all = AdminStats_all_();
  var cur = AdminStats_month_(all, ym, now);
  var prev = AdminStats_month_(all, AdminStats_shift_(ym, -1), now);
  cur.month = ym;
  cur.prev_visits = prev.visits;
  cur.is_current = ym === dateOf(now).slice(0, 7);
  return { ok: true, data: cur };
}
