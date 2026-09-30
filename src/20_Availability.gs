/**
 * 20_Availability.gs — VERSION 1.1 (29.09.2026)
 *
 * Ядро расчёта доступности. Сетка 30 мин, бронь занимает k = duration/30 слотов.
 * Ключ занятости — абсолютное время в мс, поэтому переходы через полночь однозначны.
 *
 * Изменения 1.1 (контракт не сломан, все вызовы 1.0 работают как раньше):
 *  - необязательный параметр opts: { ignoreLeadTime, ignoreDailyLimit } — для записи мастером;
 *  - буфер после сеанса больше не обязан помещаться до конца рабочего окна:
 *    после последнего сеанса дня отдыхать можно и вне рабочего времени;
 *  - лимит сеансов в день config.max_bookings_per_day (0 или пусто — без лимита).
 */

var GRID_MIN = 30;

function Availability_forDay(dateISO, durationMin, bypassCache, opts) {
  opts = opts || {};
  if (durationMin % GRID_MIN !== 0 || durationMin < GRID_MIN) {
    throw apiError('BAD_DURATION', 'Длительность должна быть кратна 30 минутам');
  }
  var k = durationMin / GRID_MIN;
  var bufAfter = CFG_INT('buffer_after_min');
  var bufSlots = Math.ceil(bufAfter / GRID_MIN);

  var windows = Schedule_windowsFor(dateISO);
  if (!windows.length) return [];

  var active = Bookings_activeForDay(dateISO, bypassCache);

  // Лимит сеансов в день: массаж — физическая работа, после N записей день закрывается.
  // Считаются только брони, которые НАЧИНАЮТСЯ в этот день.
  var dayLimit = parseInt(CFG_opt('max_bookings_per_day', '0'), 10) || 0;
  if (dayLimit > 0 && !opts.ignoreDailyLimit) {
    var startedThisDay = active.filter(function (b) {
      return dateOf(parseIsoStrict(b.start_at)) === dateISO;
    }).length;
    if (startedThisDay >= dayLimit) return [];
  }

  var busy = {};
  function mark(fromIso, toIso) {
    var from = alignDown(parseIsoStrict(fromIso), GRID_MIN);
    var to = alignUp(parseIsoStrict(toIso), GRID_MIN);
    for (var t = from.getTime(); t < to.getTime(); t += GRID_MIN * 60000) busy[t] = true;
  }

  active.forEach(function (b) {
    var svc = Services_get(b.service_id);
    var tail = svc ? (svc.buffer_after_min || bufAfter) : bufAfter;
    mark(b.start_at, addMinutesIso(b.end_at, tail));
  });
  Blocks_forDay(dateISO).forEach(function (bl) { mark(bl.start_at, bl.end_at); });
  BusyEvents_forDay(dateISO).forEach(function (ev) { mark(ev.start_at, ev.end_at); });

  var notBefore = new Date(Date.now() + CFG_INT('lead_time_min') * 60000);

  var out = [];
  windows.forEach(function (w) {
    var cur = toDate(dateISO, w.start);
    var end = toDate(dateISO, w.end);
    // Сеанс обязан закончиться внутри окна. Буфер проверяется на занятость,
    // но может выходить за конец окна.
    while (addMin(cur, durationMin).getTime() <= end.getTime()) {
      var free = true;
      for (var i = 0; i < k + bufSlots; i++) {
        if (busy[addMin(cur, i * GRID_MIN).getTime()]) { free = false; break; }
      }
      if (free && (opts.ignoreLeadTime || cur.getTime() >= notBefore.getTime())) {
        out.push({ start: iso(cur), end: iso(addMin(cur, durationMin)) });
      }
      cur = addMin(cur, GRID_MIN);
    }
  });
  return out;
}

function Availability_forRange(dateFrom, dateTo, serviceId, durationMin, opts) {
  var svc = Services_get(serviceId);
  if (!svc || !svc.is_active) throw apiError('BAD_SERVICE', 'Услуга недоступна');
  // Клиентская страница просит сетку по 30 мин, страница переноса — длительность своей записи.
  var dur = parseInt(durationMin, 10) || svc.duration_min;

  var from = toDate(dateFrom, '00:00'), to = toDate(dateTo, '00:00');
  var span = Math.round((to.getTime() - from.getTime()) / 86400000);
  if (span < 0 || span > 14) throw apiError('BAD_SLOT', 'Диапазон дат не должен превышать 14 дней');

  var horizon = addDays(new Date(), CFG_INT('horizon_days'));
  var days = [];
  for (var i = 0; i <= span; i++) {
    var d = dateOf(addDays(from, i));
    days.push({
      date: d,
      slots: toDate(d, '00:00') > horizon ? [] : Availability_forDay(d, dur, false, opts)
    });
  }
  return { timezone: TZ(), grid_min: GRID_MIN, days: days };
}
