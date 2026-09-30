/** Рабочие окна дня недели. Несколько строк на weekday = несколько окон в дне. */

function Schedule_windowsFor(dateISO) {
  var wd = weekdayOf(dateISO);
  return Sheet_readAll('schedule')
    .filter(function (r) {
      return parseInt(r.weekday, 10) === wd && String(r.is_working).toUpperCase() === 'TRUE';
    })
    .map(function (r) { return { start: Schedule_hm_(r.start_time), end: Schedule_hm_(r.end_time) }; })
    .filter(function (w) { return w.start && w.end && w.start < w.end; })
    .sort(function (a, b) { return a.start < b.start ? -1 : 1; });
}

/** Sheets может отдать время как Date — приводим к 'HH:mm'. */
function Schedule_hm_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ(), 'HH:mm');
  var s = String(v || '').trim();
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
}

function Schedule_all() {
  return Sheet_readAll('schedule').map(function (r) {
    return {
      weekday: parseInt(r.weekday, 10),
      is_working: String(r.is_working).toUpperCase() === 'TRUE',
      start_time: Schedule_hm_(r.start_time),
      end_time: Schedule_hm_(r.end_time),
      note: r.note || ''
    };
  });
}

function Schedule_set(rows) {
  rows.forEach(function (r) {
    if (!r.is_working) return;
    if (!/^([01][0-9]|2[0-3]):(00|30)$/.test(r.start_time) || !/^([01][0-9]|2[0-3]):(00|30)$/.test(r.end_time)) {
      throw apiError('BAD_SLOT', 'Время должно быть на сетке 30 минут: ' + r.start_time + '–' + r.end_time);
    }
    if (r.end_time <= r.start_time) throw apiError('BAD_SLOT', 'Конец окна должен быть позже начала');
  });
  for (var wd = 1; wd <= 7; wd++) {
    var same = rows.filter(function (r) { return r.weekday === wd && r.is_working; })
      .sort(function (a, b) { return a.start_time < b.start_time ? -1 : 1; });
    for (var i = 1; i < same.length; i++) {
      if (same[i].start_time < same[i - 1].end_time) {
        throw apiError('BAD_SLOT', 'Рабочие окна одного дня не должны пересекаться');
      }
    }
  }
  var sh = SH('schedule');
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  rows.forEach(function (r) {
    Sheet_append('schedule', {
      weekday: r.weekday,
      is_working: r.is_working ? 'TRUE' : 'FALSE',
      start_time: r.start_time,
      end_time: r.end_time,
      note: r.note || ''
    });
  });
  return true;
}
