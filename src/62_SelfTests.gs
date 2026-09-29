/**
 * 62_SelfTests.gs — VERSION 1.1 (29.09.2026): кейс буфера под движок 1.1, кейс буфера вокруг записи.
 */
/**
 * Единственная автоматическая проверка в проекте: GAS не даёт тестового рантайма.
 * Запускать вручную из редактора ПЕРЕД каждым обновлением продового деплоя.
 * Тест работает на реальной таблице: подменяет график и данные, затем восстанавливает.
 */

function runSelfTests() {
  var results = [];
  var backupSchedule = Schedule_all();
  var testDate = dateOf(addDays(new Date(), 3));
  var wd = weekdayOf(testDate);

  function setWindow(windows) {
    var rows = [];
    for (var d = 1; d <= 7; d++) {
      if (d === wd) {
        windows.forEach(function (w) { rows.push({ weekday: d, is_working: true, start_time: w[0], end_time: w[1], note: 'selftest' }); });
      } else {
        rows.push({ weekday: d, is_working: false, start_time: '10:00', end_time: '20:00', note: '' });
      }
    }
    Schedule_set(rows);
    CFG_invalidate();
  }

  function check(name, actual, expected) {
    var a = JSON.stringify(actual), e = JSON.stringify(expected);
    results.push((a === e ? 'OK   ' : 'FAIL ') + name + (a === e ? '' : '\n      получено: ' + a + '\n      ожидалось: ' + e));
  }

  function starts(durationMin) {
    return Availability_forDay(testDate, durationMin, true).map(function (s) { return fmtHM(parseIsoStrict(s.start)); });
  }

  function expectThrows(name, code, fn) {
    try { fn(); results.push('FAIL ' + name + ' — исключение не выброшено'); }
    catch (e) { results.push((e.code === code ? 'OK   ' : 'FAIL ') + name + (e.code === code ? '' : ' — код ' + e.code)); }
  }

  var leadBackup = CFG_opt('lead_time_min', '120');
  var bufBackup = CFG_opt('buffer_after_min', '0');

  try {
    CFG_set('lead_time_min', '0');
    CFG_set('buffer_after_min', '0');
    resetTestVolatile_();

    setWindow([['10:00', '11:30']]);
    check('эталон ТЗ: окно 10:00-11:30, услуга 60', starts(60), ['10:00', '10:30']);

    setWindow([['10:00', '12:00']]);
    check('услуга 90 в окне 10:00-12:00', starts(90), ['10:00', '10:30']);

    // Этап 12.5: нижний порог снят до GRID_MIN (30) — минимум слотов теперь проверяется
    // в Api_bookingCreate по min_slots_per_booking, а не здесь.
    check('длительность 30 мин теперь допустима (= сетке)', starts(30).length > 0, true);
    expectThrows('длительность 45 отклоняется (не кратна 30)', 'BAD_DURATION', function () { Availability_forDay(testDate, 45, true); });
    expectThrows('длительность 0 отклоняется (меньше сетки)', 'BAD_DURATION', function () { Availability_forDay(testDate, 0, true); });

    setWindow([['10:00', '13:00']]);
    var bl = Blocks_insert({ start_at: iso(toDate(testDate, '11:00')), end_at: iso(toDate(testDate, '12:00')), reason: 'selftest', push_to_calendar: 'FALSE' });
    check('блокировка 11:00-12:00 убирает пересекающиеся старты', starts(60), ['10:00', '12:00']);
    Blocks_delete(bl.block_id);

    BusyEvents_upsert('selftest_ev', toDate(testDate, '10:00'), toDate(testDate, '11:00'), 'Личное', false);
    check('внешнее событие 10:00-11:00 блокирует слоты', starts(60), ['11:00', '11:30', '12:00']);
    BusyEvents_delete('selftest_ev');

    BusyEvents_upsertAllDay('selftest_allday', testDate, dateOf(addDays(toDate(testDate, '00:00'), 1)), 'Отпуск');
    check('all-day событие блокирует день целиком', starts(60), []);
    BusyEvents_delete('selftest_allday');

    setWindow([['10:00', '14:00'], ['16:00', '20:00']]);
    var s2 = starts(60);
    check('два окна в дне: нет стартов между 13:00 и 16:00',
      s2.filter(function (h) { return h > '13:00' && h < '16:00'; }), []);

    setWindow([['00:00', '23:30']]);
    CFG_set('lead_time_min', String(24 * 60 * 4));
    check('lead_time отсекает ближний горизонт', starts(60), []);
    CFG_set('lead_time_min', '0');

    setWindow([['10:00', '12:00']]);
    CFG_set('buffer_after_min', '30');
    // С версии 1.1 движка буфер не обязан помещаться до конца окна: 11:00–12:00 допустим.
    check('буфер 30 мин после последнего сеанса не съедает окно', starts(60), ['10:00', '10:30', '11:00']);
    var bk = Bookings_insert({ booking_id: 'selftest_bk', request_id: 'selftest_bk', client_id: 'selftest',
      service_id: Services_list(true)[0].service_id, start_at: iso(toDate(testDate, '11:00')),
      end_at: iso(toDate(testDate, '11:30')), status: 'confirmed', comment: '', source: 'admin',
      calendar_sync_status: 'synced', gcal_event_id: '', created_at: nowIso() });
    check('буфер 30 мин после чужой записи и перед ней', starts(30), ['10:00']);
    Bookings_update(bk.booking_id, { status: 'cancelled_by_master' });
    CFG_set('buffer_after_min', '0');

  } finally {
    Schedule_set(backupSchedule);
    CFG_set('lead_time_min', leadBackup);
    CFG_set('buffer_after_min', bufBackup);
    resetTestVolatile_();
  }

  var failed = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length;
  var out = results.join('\n') + '\n\n' + (failed ? '=== ПРОВАЛЕНО ТЕСТОВ: ' + failed + ' ===' : '=== ВСЕ ТЕСТЫ ПРОЙДЕНЫ ===');
  console.log(out);
  return out;
}

function resetTestVolatile_() {
  Bookings_invalidate();
  CFG_invalidate();
  Blocks_all().forEach(function (b) { if (b.reason === 'selftest') Blocks_delete(b.block_id); });
  ['selftest_ev', 'selftest_allday'].forEach(function (id) { BusyEvents_delete(id); });
}
