/** Доступ к таблице, работа со временем, ошибки. Определяются раньше бизнес-логики. */

var SS_CACHE_ = null;

function SS() {
  if (SS_CACHE_) return SS_CACHE_;
  var id = PROP('SPREADSHEET_ID');
  if (!id) throw apiError('INTERNAL', 'SPREADSHEET_ID не задан в свойствах скрипта');
  SS_CACHE_ = SpreadsheetApp.openById(id);
  return SS_CACHE_;
}

function SH(name) {
  var sh = SS().getSheetByName(name);
  if (!sh) throw apiError('INTERNAL', 'Лист "' + name + '" не найден. Выполните setup().');
  return sh;
}

function Sheet_head(name) {
  var sh = SH(name);
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
}

function Sheet_readAll(name) {
  var values = SH(name).getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values.shift();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === '') continue;
    out.push(rowToObj(head, values[i]));
  }
  return out;
}

function rowToObj(head, row) {
  var o = {};
  for (var i = 0; i < head.length; i++) o[head[i]] = row[i];
  return o;
}

function Sheet_append(name, obj) {
  var head = Sheet_head(name);
  SH(name).appendRow(head.map(function (k) {
    var v = obj[k];
    return (v === undefined || v === null) ? '' : v;
  }));
  return obj;
}

function Sheet_findRow(name, keyCol, keyVal) {
  var sh = SH(name);
  var head = Sheet_head(name);
  var col = head.indexOf(keyCol) + 1;
  if (col === 0) throw apiError('INTERNAL', 'Колонка ' + keyCol + ' отсутствует в листе ' + name);
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var vals = sh.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(keyVal)) return i + 2;
  }
  return -1;
}

function Sheet_update(name, keyCol, keyVal, patch) {
  var rowIdx = Sheet_findRow(name, keyCol, keyVal);
  if (rowIdx < 0) return false;
  var sh = SH(name);
  var head = Sheet_head(name);
  var row = sh.getRange(rowIdx, 1, 1, head.length).getValues()[0];
  Object.keys(patch).forEach(function (k) {
    var c = head.indexOf(k);
    if (c >= 0) row[c] = (patch[k] === undefined || patch[k] === null) ? '' : patch[k];
  });
  sh.getRange(rowIdx, 1, 1, head.length).setValues([row]);
  return true;
}

function Sheet_delete(name, keyCol, keyVal) {
  var rowIdx = Sheet_findRow(name, keyCol, keyVal);
  if (rowIdx < 0) return false;
  SH(name).deleteRow(rowIdx);
  return true;
}

function Utils_uuid() { return Utilities.getUuid(); }

function iso(d) { return Utilities.formatDate(d, TZ(), "yyyy-MM-dd'T'HH:mm:ssXXX"); }

function parseIsoStrict(s) {
  if (s instanceof Date) return s;
  var str = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/.test(str)) {
    throw apiError('BAD_SLOT', 'Время должно быть в ISO-8601 с офсетом: ' + str);
  }
  var d = new Date(str);
  if (isNaN(d.getTime())) throw apiError('BAD_SLOT', 'Некорректное время: ' + str);
  return d;
}

function addMin(d, m) { return new Date(d.getTime() + m * 60000); }
function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }
function addMinutesIso(isoStr, m) { return iso(addMin(parseIsoStrict(isoStr), m)); }

function alignDown(d, stepMin) { var ms = stepMin * 60000; return new Date(Math.floor(d.getTime() / ms) * ms); }
function alignUp(d, stepMin) { var ms = stepMin * 60000; return new Date(Math.ceil(d.getTime() / ms) * ms); }
function isOnGrid(d, stepMin) { return d.getTime() % (stepMin * 60000) === 0; }

function fmtHM(d) { return Utilities.formatDate(d, TZ(), 'HH:mm'); }
function fmtDM(d) { return Utilities.formatDate(d, TZ(), 'dd.MM'); }
function dateOf(d) { return Utilities.formatDate(d, TZ(), 'yyyy-MM-dd'); }

function tzOffsetFor(dateISO) {
  return Utilities.formatDate(new Date(dateISO + 'T12:00:00Z'), TZ(), 'XXX');
}

function toDate(dateISO, hm) {
  return new Date(dateISO + 'T' + hm + ':00' + tzOffsetFor(dateISO));
}

function dayBounds(dateISO) {
  var s = toDate(dateISO, '00:00');
  return { start: s, end: addDays(s, 1) };
}

function weekdayOf(dateISO) {
  return parseInt(Utilities.formatDate(toDate(dateISO, '12:00'), TZ(), 'u'), 10);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aEnd.getTime() > bStart.getTime() && aStart.getTime() < bEnd.getTime();
}

function apiError(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

function nowIso() { return iso(new Date()); }
