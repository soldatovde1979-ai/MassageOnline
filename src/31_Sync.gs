/** Импорт занятости. Инкрементально по syncToken, с подавлением echo-петли. */

function syncFromCalendar() {
  var t0 = Date.now();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  var seen = 0;
  try {
    var token = PROP('CAL_SYNC_TOKEN');
    var calId = CFG('calendar_id');
    var pageToken = null, newSyncToken = null;

    do {
      var params = { showDeleted: true, singleEvents: true, maxResults: 250 };
      if (token) {
        params.syncToken = token;
      } else {
        params.timeMin = new Date().toISOString();
        params.timeMax = addDays(new Date(), CFG_INT('horizon_days') + 7).toISOString();
      }
      if (pageToken) params.pageToken = pageToken;

      var resp;
      try {
        resp = Calendar.Events.list(calId, params);
      } catch (err) {
        if (String(err).indexOf('410') !== -1) {
          PROP_del('CAL_SYNC_TOKEN');
          Audit_log('syncFromCalendar', 'OK', Date.now() - t0, '', 'syncToken протух, полная перезагрузка на следующем тике', 'trigger');
          return;
        }
        throw err;
      }

      (resp.items || []).forEach(function (ev) { applyCalendarEvent(ev); seen++; });
      pageToken = resp.nextPageToken || null;
      newSyncToken = resp.nextSyncToken || newSyncToken;
    } while (pageToken);

    if (newSyncToken) PROP_set('CAL_SYNC_TOKEN', newSyncToken);
    PROP_set('CAL_LAST_SYNC_AT', nowIso());
    Audit_log('syncFromCalendar', 'OK', Date.now() - t0, '', 'событий: ' + seen, 'trigger');
  } catch (e) {
    Audit_log('syncFromCalendar', 'ERROR', Date.now() - t0, e.code || 'INTERNAL', e.message, 'trigger');
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function applyCalendarEvent(ev) {
  var priv = (ev.extendedProperties && ev.extendedProperties.private) || {};

  // Ветка 1: событие создано нашим сервисом — в busy_events НЕ попадает никогда.
  if (priv.created_via === 'massage_booking_app') {
    if (priv.block_id) {
      if (ev.status === 'cancelled') Blocks_delete(priv.block_id);
      return;
    }
    if (!priv.booking_id) return;
    var b = Bookings_get(priv.booking_id);
    if (!b) return;
    if (ev.status === 'cancelled') {
      if (b.status === 'confirmed') {
        Bookings_setStatus(priv.booking_id, 'cancelled_by_master', 'calendar_delete');
        Notify_send('booking_cancelled_externally', { booking: Bookings_get(priv.booking_id) });
      }
    } else if (ev.start && ev.start.dateTime) {
      Bookings_syncTimeFromCalendar(priv.booking_id, ev.start.dateTime, ev.end.dateTime);
    }
    return;
  }

  // Ветка 2: личное событие мастера — внешняя блокировка слотов.
  if (ev.status === 'cancelled') { BusyEvents_delete(ev.id); return; }
  if (ev.transparency === 'transparent') { BusyEvents_delete(ev.id); return; }
  if (ev.start && ev.start.date) {
    BusyEvents_upsertAllDay(ev.id, ev.start.date, ev.end.date, ev.summary);
    return;
  }
  if (!ev.start || !ev.start.dateTime) return;
  BusyEvents_upsert(ev.id, ev.start.dateTime, ev.end.dateTime, ev.summary, false);
}
