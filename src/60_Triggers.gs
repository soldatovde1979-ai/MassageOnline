function installTriggers() {
  removeTriggers();
  ScriptApp.newTrigger('syncFromCalendar').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('flushOutbox').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('dailyMaintenance').timeBased().atHour(3).everyDays(1).create();
  return 'Триггеры установлены: syncFromCalendar 5 мин, flushOutbox 1 мин, dailyMaintenance 03:00';
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

function dailyMaintenance() {
  var t0 = Date.now();
  try {
    Maintenance_repairStuck_();
    var moved = Bookings_archiveOlderThan(CFG_INT('retention_months'));
    var done = Bookings_markCompleted();
    Audit_rotate(50000, 20000);
    var purged = BusyEvents_purgePast(7);
    Notify_masterDailyDigest();
    Audit_log('dailyMaintenance', 'OK', Date.now() - t0, '',
      'архив: ' + moved + ', завершено: ' + done + ', очищено событий: ' + purged, 'trigger');
  } catch (e) {
    Audit_log('dailyMaintenance', 'ERROR', Date.now() - t0, e.code || 'INTERNAL', e.message, 'trigger');
    throw e;
  }
}

/** Страховка: бронь, застрявшая в переносе из-за обрыва выполнения, возвращается в confirmed. */
function Maintenance_repairStuck_() {
  Bookings_all(true).forEach(function (b) {
    if (b.status === 'rescheduling') Bookings_update(b.booking_id, { status: 'confirmed' });
  });
}
