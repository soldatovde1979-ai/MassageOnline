/** 60_Triggers.gs — VERSION 1.2 (30.09.2026): + sendReminders, eveningDigest (15.3; сводка — вечером вместо 03:00); + weeklyBackup (15.6). */

function installTriggers() {
  removeTriggers();
  ScriptApp.newTrigger('syncFromCalendar').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('flushOutbox').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('dailyMaintenance').timeBased().atHour(3).everyDays(1).create();
  // Этап 15.3: напоминания клиентам и вечерняя сводка мастеру
  ScriptApp.newTrigger('sendReminders').timeBased().everyMinutes(15).create();
  var h = parseInt(CFG_opt('digest_hour', '20'), 10);
  if (!(h >= 0 && h <= 23)) h = 20;
  ScriptApp.newTrigger('eveningDigest').timeBased().atHour(h).everyDays(1).create();
  // Этап 15.6: резервная копия таблицы раз в неделю
  ScriptApp.newTrigger('weeklyBackup').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(4).create();
  return 'Триггеры установлены: syncFromCalendar 5 мин, flushOutbox 1 мин, dailyMaintenance 03:00, ' +
    'sendReminders 15 мин, eveningDigest ' + h + ':00, weeklyBackup вс 04:00';
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
    Audit_log('dailyMaintenance', 'OK', Date.now() - t0, '',
      'архив: ' + moved + ', завершено: ' + done + ', очищено событий: ' + purged, 'trigger');
  } catch (e) {
    Audit_log('dailyMaintenance', 'ERROR', Date.now() - t0, e.code || 'INTERNAL', e.message, 'trigger');
    Notify_dev('dailyMaintenance упал: ' + e.message);
    throw e;
  }
}

/** Триггер вечерней сводки (этап 15.3). Сводка переехала с утра на вечер: «завтра у тебя …». */
function eveningDigest() {
  try { Notify_eveningDigest(); }
  catch (e) { Notify_dev('eveningDigest упал: ' + e.message); throw e; }
}

/** Страховка: бронь, застрявшая в переносе из-за обрыва выполнения, возвращается в confirmed. */
function Maintenance_repairStuck_() {
  Bookings_all(true).forEach(function (b) {
    if (b.status === 'rescheduling') Bookings_update(b.booking_id, { status: 'confirmed' });
  });
}
