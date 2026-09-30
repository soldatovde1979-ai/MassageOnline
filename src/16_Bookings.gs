/** Брони. Кэш индекса TTL 60 c, инвалидируется после каждой записи. */

var BOOKINGS_CACHE_KEY = 'bookings_idx';

function Bookings_invalidate() { CacheService.getScriptCache().remove(BOOKINGS_CACHE_KEY); }

/** @param {boolean} bypassCache внутри критической секции читаем лист напрямую */
function Bookings_all(bypassCache) {
  if (!bypassCache) {
    var c = CacheService.getScriptCache().get(BOOKINGS_CACHE_KEY);
    if (c) return JSON.parse(c);
  }
  var rows = Sheet_readAll('bookings');
  rows.forEach(function (b) {
    b.start_at = Bookings_isoCell_(b.start_at);
    b.end_at = Bookings_isoCell_(b.end_at);
  });
  if (!bypassCache) {
    try { CacheService.getScriptCache().put(BOOKINGS_CACHE_KEY, JSON.stringify(rows), 60); } catch (e) { }
  }
  return rows;
}

/** Sheets может вернуть дату как Date — приводим обратно к ISO с офсетом. */
function Bookings_isoCell_(v) {
  return (v instanceof Date) ? iso(v) : String(v);
}

function Bookings_get(id) {
  var all = Bookings_all(true);
  for (var i = 0; i < all.length; i++) if (all[i].booking_id === id) return all[i];
  return null;
}

function Bookings_findByRequestId(requestId) {
  if (!requestId) return null;
  var all = Bookings_all(true);
  for (var i = 0; i < all.length; i++) if (String(all[i].request_id) === String(requestId)) return all[i];
  return null;
}

function Bookings_activeForRange(fromDate, toDate_, bypassCache) {
  return Bookings_all(bypassCache).filter(function (b) {
    if (b.status !== 'confirmed') return false;
    return overlaps(parseIsoStrict(b.start_at), parseIsoStrict(b.end_at), fromDate, toDate_);
  });
}

function Bookings_activeForDay(dateISO, bypassCache) {
  var d = dayBounds(dateISO);
  return Bookings_activeForRange(d.start, d.end, bypassCache);
}

function Bookings_insert(o) {
  o.manage_token_ver = o.manage_token_ver || 1;
  o.calendar_sync_attempts = 0;
  o.next_retry_at = '';
  o.updated_at = o.created_at;
  Sheet_append('bookings', o);
  Bookings_invalidate();
  return o;
}

function Bookings_update(id, patch) {
  patch.updated_at = nowIso();
  var ok = Sheet_update('bookings', 'booking_id', id, patch);
  Bookings_invalidate();
  return ok;
}

function Bookings_setStatus(id, status, reason) {
  var b = Bookings_get(id);
  if (!b) return false;
  var patch = { status: status, cancelled_at: nowIso(), cancel_reason: reason || '' };
  if (b.gcal_event_id && reason !== 'calendar_delete') patch.calendar_sync_status = 'deleting';
  if (reason === 'calendar_delete') patch.calendar_sync_status = 'synced';
  return Bookings_update(id, patch);
}

function Bookings_syncTimeFromCalendar(id, startIso, endIso) {
  var b = Bookings_get(id);
  if (!b) return false;
  var s = iso(new Date(startIso)), e = iso(new Date(endIso));
  if (b.start_at === s && b.end_at === e) return false;
  return Bookings_update(id, { start_at: s, end_at: e, calendar_sync_status: 'synced' });
}

function Bookings_toPublic(b) {
  var svc = Services_get(b.service_id);
  return {
    booking_id: b.booking_id,
    start_at: b.start_at,
    end_at: b.end_at,
    service_title: svc ? svc.title : b.service_id,
    service_id: b.service_id,
    duration_min: svc ? svc.duration_min : 0,
    status: b.status,
    comment: b.comment || '',
    manage_url: Security_buildManageUrl(b)
  };
}

function Bookings_markCompleted() {
  var now = new Date(), n = 0;
  Bookings_all(true).forEach(function (b) {
    if (b.status === 'confirmed' && parseIsoStrict(b.end_at) < now) {
      Bookings_update(b.booking_id, { status: 'completed' });
      n++;
    }
  });
  return n;
}

function Bookings_archiveOlderThan(months) {
  var edge = addDays(new Date(), -Math.round(months * 30.4));
  var moved = 0;
  Bookings_all(true).forEach(function (b) {
    if (parseIsoStrict(b.start_at) < edge) {
      Sheet_append('bookings_archive', b);
      Sheet_delete('bookings', 'booking_id', b.booking_id);
      moved++;
    }
  });
  if (moved) Bookings_invalidate();
  return moved;
}

function Bookings_outboxBatch(limit) {
  var now = new Date();
  return Bookings_all(true).filter(function (b) {
    if (b.calendar_sync_status !== 'pending' && b.calendar_sync_status !== 'deleting') return false;
    if (parseInt(b.calendar_sync_attempts || 0, 10) >= 5) return false;
    if (b.next_retry_at && parseIsoStrict(Bookings_isoCell_(b.next_retry_at)) > now) return false;
    return true;
  }).slice(0, limit);
}

function Bookings_activeCountForClient(clientId) {
  var now = new Date();
  return Bookings_all(true).filter(function (b) {
    return b.client_id === clientId && b.status === 'confirmed' && parseIsoStrict(b.start_at) > now;
  }).length;
}
