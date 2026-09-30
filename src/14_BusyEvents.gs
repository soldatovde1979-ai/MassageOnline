/** Проекция чужих событий Google Calendar. Кэш, восстановимый полной перезагрузкой. */

function BusyEvents_all() { return Sheet_readAll('busy_events'); }

function BusyEvents_forRange(fromDate, toDate_) {
  return BusyEvents_all().filter(function (e) {
    return overlaps(parseIsoStrict(e.start_at), parseIsoStrict(e.end_at), fromDate, toDate_);
  });
}

function BusyEvents_forDay(dateISO) {
  var d = dayBounds(dateISO);
  return BusyEvents_forRange(d.start, d.end);
}

function BusyEvents_upsert(eventId, startIso, endIso, summary, isAllDay) {
  var row = {
    gcal_event_id: eventId,
    start_at: iso(new Date(startIso)),
    end_at: iso(new Date(endIso)),
    is_all_day: isAllDay ? 'TRUE' : 'FALSE',
    title_masked: String(summary || 'Занято').slice(0, 40),
    updated_at: nowIso()
  };
  if (Sheet_findRow('busy_events', 'gcal_event_id', eventId) > 0) {
    Sheet_update('busy_events', 'gcal_event_id', eventId, row);
  } else {
    Sheet_append('busy_events', row);
  }
}

function BusyEvents_upsertAllDay(eventId, startDate, endDate, summary) {
  BusyEvents_upsert(eventId, toDate(startDate, '00:00'), toDate(endDate, '00:00'), summary, true);
}

function BusyEvents_delete(eventId) { return Sheet_delete('busy_events', 'gcal_event_id', eventId); }

function BusyEvents_purgePast(days) {
  var edge = addDays(new Date(), -days);
  var removed = 0;
  BusyEvents_all().forEach(function (e) {
    if (parseIsoStrict(e.end_at) < edge) { BusyEvents_delete(e.gcal_event_id); removed++; }
  });
  return removed;
}
