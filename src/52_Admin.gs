function Api_adminLogin(req) {
  Security_checkPin((req.payload || {}).pin);
  return { ok: true, data: { token: Security_issueAdminToken() } };
}

function Admin_auth_(req) { Security_verifyAdminToken(req.auth && req.auth.token); }

function Api_adminAgenda(req) {
  Admin_auth_(req);
  var p = req.payload || {};
  var from = toDate(p.date_from, '00:00');
  var to = addDays(toDate(p.date_to, '00:00'), 1);

  var items = [];
  // Этап 15.1: в агенде видны и прошедшие записи (completed / no_show), не только активные.
  Bookings_all(true).filter(function (b) {
    if (ADMIN_BK_STATUSES_VISIBLE.indexOf(b.status) < 0) return false;
    return overlaps(parseIsoStrict(b.start_at), parseIsoStrict(b.end_at), from, to);
  }).forEach(function (b) {
    var c = Clients_get(b.client_id), s = Services_get(b.service_id);
    items.push({
      kind: 'booking', id: b.booking_id, start_at: b.start_at, end_at: b.end_at,
      title: c ? (c.name + ' — ' + Phone_format(c.phone)) : '(клиент удалён)',
      name: c ? c.name : '', phone: c ? c.phone : '', client_id: b.client_id,
      service_title: s ? s.title : b.service_id, source: b.source || 'web',
      slots: Math.round((parseIsoStrict(b.end_at) - parseIsoStrict(b.start_at)) / (GRID_MIN * 60000)),
      status: b.status, calendar_sync_status: b.calendar_sync_status, comment: b.comment || '',
      client_note: c ? String(c.notes || '').slice(0, 140) : ''   // этап 15.4: заметка мастера — видна в листе записи
    });
  });
  Blocks_forRange(from, to).forEach(function (bl) {
    items.push({ kind: 'block', id: bl.block_id, start_at: bl.start_at, end_at: bl.end_at, title: bl.reason || 'Занято' });
  });
  BusyEvents_forRange(from, to).forEach(function (ev) {
    items.push({ kind: 'external', id: ev.gcal_event_id, start_at: ev.start_at, end_at: ev.end_at, title: ev.title_masked || 'Личное' });
  });
  items.sort(function (a, b) { return a.start_at < b.start_at ? -1 : 1; });

  var windows = [];
  for (var i = 0; ; i++) {
    var d = dateOf(addDays(from, i));
    if (toDate(d, '00:00') >= to) break;
    Schedule_windowsFor(d).forEach(function (w) { windows.push({ date: d, start: w.start, end: w.end }); });
  }

  return {
    ok: true,
    data: {
      range: { from: p.date_from, to: p.date_to },
      timezone: TZ(),
      work_windows: windows,
      items: items,
      last_sync_at: PROP('CAL_LAST_SYNC_AT') || ''
    }
  };
}

function Api_adminBlockCreate(req) {
  Admin_auth_(req);
  var p = req.payload || {};
  var start = parseIsoStrict(p.start_at), end = parseIsoStrict(p.end_at);
  if (end <= start) throw apiError('BAD_SLOT', 'Конец должен быть позже начала');
  if (!isOnGrid(start, GRID_MIN) || !isOnGrid(end, GRID_MIN)) {
    throw apiError('BAD_SLOT', 'Границы блокировки должны лежать на сетке 30 минут');
  }

  var conflicts = Bookings_activeForRange(start, end, true).map(function (b) {
    var c = Clients_get(b.client_id);
    return { booking_id: b.booking_id, start_at: b.start_at, title: c ? c.name : '' };
  });
  if (conflicts.length && p.force !== true) {
    return { ok: false, error: { code: 'CONFLICT', message: 'Интервал пересекается с записями', retryable: false }, conflicts: conflicts };
  }

  var block = Blocks_insert({
    start_at: iso(start),
    end_at: iso(end),
    reason: String(p.reason || '').slice(0, 100),
    push_to_calendar: p.push_to_calendar === false ? 'FALSE' : 'TRUE',
    gcal_event_id: ''
  });
  return { ok: true, data: block };
}

function Api_adminBlockDelete(req) {
  Admin_auth_(req);
  var bl = Blocks_get((req.payload || {}).block_id);
  if (!bl) throw apiError('NOT_FOUND', 'Блокировка не найдена');
  if (bl.gcal_event_id) { try { CalExport_remove(bl.gcal_event_id); } catch (e) { } }
  Blocks_delete(bl.block_id);
  return { ok: true, data: { block_id: bl.block_id } };
}

function Api_adminScheduleGet(req) {
  Admin_auth_(req);
  return { ok: true, data: { schedule: Schedule_all(), services: Services_list(false), config: CFG_all() } };
}

function Api_adminScheduleSet(req) {
  Admin_auth_(req);
  Schedule_set((req.payload || {}).rows || []);
  return { ok: true, data: { saved: true } };
}

function Api_adminBookingCancel(req) {
  Admin_auth_(req);
  var b = Bookings_get((req.payload || {}).booking_id);
  if (!b) throw apiError('NOT_FOUND', 'Запись не найдена');
  Bookings_setStatus(b.booking_id, 'cancelled_by_master', 'master_admin');
  return { ok: true, data: { booking_id: b.booking_id, status: 'cancelled_by_master' } };
}
