/**
 * gas-emulator.js — VERSION = "1.1"  (1.1: Utilities.newBlob для подписи Telegram)
 * Локальный эмулятор Google Apps Script для прогона серверного кода massage_booking_app в Node.
 * Загружает src/*.gs В ТОМ ЖЕ ПОРЯДКЕ, что и GAS (сортировка по имени), каждый файл — отдельным
 * скриптом в общем глобальном контексте. Так же, как в GAS V8, ссылка верхнего уровня на функцию
 * из файла, который грузится позже, падает — эмулятор это ловит.
 *
 * Ограничения (осознанные): Sheets хранит значения как есть (реальные Sheets превращают ISO-строки
 * в Date и 'TRUE' в boolean); Calendar/UrlFetch/Mail — записывающие заглушки.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function makeSheet(name) {
  const rows = []; // массив массивов
  const width = () => rows.reduce((m, r) => Math.max(m, r.length), 0);
  const sheet = {
    _rows: rows,
    getName: () => name,
    getLastRow: () => rows.length,
    getLastColumn: () => width(),
    getDataRange() { return sheet.getRange(1, 1, Math.max(rows.length, 1), Math.max(width(), 1)); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const src = rows[r - 1 + i] || [];
            const line = [];
            for (let j = 0; j < nc; j++) line.push(src[c - 1 + j] === undefined ? '' : src[c - 1 + j]);
            out.push(line);
          }
          return out;
        },
        setValues(vals) {
          for (let i = 0; i < vals.length; i++) {
            const idx = r - 1 + i;
            while (rows.length <= idx) rows.push([]);
            for (let j = 0; j < vals[i].length; j++) rows[idx][c - 1 + j] = vals[i][j];
          }
          return this;
        },
        setValue(v) { return this.setValues([[v]]); },
        setFontWeight() { return this; },
        setNumberFormat() { return this; }
      };
    },
    appendRow(arr) { rows.push(arr.slice()); return sheet; },
    deleteRow(i) { rows.splice(i - 1, 1); },
    deleteRows(i, n) { rows.splice(i - 1, n); },
    setFrozenRows() { },
    clear() { rows.length = 0; }
  };
  return sheet;
}

function makeSpreadsheet() {
  const sheets = [makeSheet('Sheet1')];
  return {
    _sheets: sheets,
    getId: () => 'TEST_SS',
    getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
    insertSheet(n) { const s = makeSheet(n); sheets.push(s); return s; },
    getSheets: () => sheets.slice(),
    deleteSheet(s) { const i = sheets.indexOf(s); if (i >= 0) sheets.splice(i, 1); }
  };
}

// --- Utilities.formatDate: подмножество SimpleDateFormat ---
function formatDate(date, tz, fmt) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short'
  }).formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offMin = Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const XXX = sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
  const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  let out = '';
  for (let i = 0; i < fmt.length;) {
    if (fmt[i] === "'") { const j = fmt.indexOf("'", i + 1); out += fmt.slice(i + 1, j); i = j + 1; continue; }
    const m = fmt.slice(i).match(/^(yyyy|MM|dd|HH|mm|ss|XXX|u|EEE)/);
    if (m) {
      const t = m[1];
      out += t === 'yyyy' ? parts.year : t === 'MM' ? parts.month : t === 'dd' ? parts.day
        : t === 'HH' ? parts.hour : t === 'mm' ? parts.minute : t === 'ss' ? parts.second
        : t === 'XXX' ? XXX : t === 'u' ? String(WD[parts.weekday]) : parts.weekday;
      i += t.length; continue;
    }
    out += fmt[i++];
  }
  return out;
}

const toSigned = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
const toBuf = (v) => Buffer.from(Array.isArray(v) ? v.map((b) => (b + 256) % 256) : String(v), Array.isArray(v) ? undefined : 'utf8');

function createGas(opts) {
  opts = opts || {};
  const log = { mail: [], calendar: [], fetch: [], console: [] };
  const props = Object.assign({ SPREADSHEET_ID: 'TEST_SS' }, opts.props || {});
  const cache = new Map();
  const ss = makeSpreadsheet();
  let evSeq = 0;
  const ctx = {
    console,
    Logger: { log: (...a) => log.console.push(a.join(' ')) },
    SpreadsheetApp: { openById: () => ss, flush() { } },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
        getProperties: () => Object.assign({}, props),
        setProperties: (o) => Object.assign(props, o)
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, String(v)); },
        remove: (k) => { cache.delete(k); },
        removeAll: (ks) => ks.forEach((k) => cache.delete(k))
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() { }, releaseLock() { }, hasLock: () => true }) },
    Utilities: {
      formatDate,
      getUuid: () => crypto.randomUUID(),
      base64EncodeWebSafe: (bytes) => toBuf(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64Encode: (bytes) => toBuf(bytes).toString('base64'),
      computeHmacSha256Signature: (msg, key) => toSigned(crypto.createHmac('sha256', toBuf(key)).update(toBuf(msg)).digest()),
      newBlob: (str) => ({ getBytes: () => toSigned(Buffer.from(String(str), 'utf8')), getDataAsString: () => String(str) }),
      computeDigest: (alg, s) => toSigned(crypto.createHash('sha256').update(toBuf(s)).digest()),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      sleep() { }
    },
    MailApp: { sendEmail: (...a) => log.mail.push(a) },
    Calendar: {
      Events: {
        insert: (ev, cal) => { const id = 'ev' + (++evSeq); log.calendar.push(['insert', id, ev]); return Object.assign({ id }, ev); },
        patch: (ev, cal, id) => { log.calendar.push(['patch', id, ev]); return Object.assign({ id }, ev); },
        remove: (cal, id) => { log.calendar.push(['remove', id]); },
        list: () => ({ items: [], nextSyncToken: 'sync1' })
      }
    },
    UrlFetchApp: { fetch: (url, o) => { log.fetch.push([url, o]); return { getResponseCode: () => 200, getContentText: () => '{"ok":true,"result":{}}' }; } },
    ScriptApp: { newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() { } }), atHour: () => ({ everyDays: () => ({ create() { } }) }) }) }), getProjectTriggers: () => [], deleteTrigger() { } },
    HtmlService: { XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' } },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }) },
    Session: { getScriptTimeZone: () => 'Europe/Moscow' }
  };
  vm.createContext(ctx);
  const dir = opts.srcDir || path.join(__dirname, '..', 'src'); // тесты лежат ВНЕ src: clasp не должен их заливать
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).sort();
  files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f }));
  return { ctx, log, props, ss, cache, files };
}

module.exports = { createGas, formatDate };
