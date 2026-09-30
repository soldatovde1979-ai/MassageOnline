/** Первичная установка. Запускается вручную из редактора Apps Script. */

var SCHEMA = {
  services: ['service_id', 'title', 'duration_min', 'buffer_after_min', 'price', 'sort_order', 'is_active'],
  schedule: ['weekday', 'is_working', 'start_time', 'end_time', 'note'],
  blocks: ['block_id', 'start_at', 'end_at', 'reason', 'push_to_calendar', 'gcal_event_id', 'created_at'],
  busy_events: ['gcal_event_id', 'start_at', 'end_at', 'is_all_day', 'title_masked', 'updated_at'],
  clients: ['client_id', 'phone', 'name', 'identity_provider', 'identity_ref', 'tg_chat_id', 'consent_at',
    'first_seen_at', 'last_seen_at', 'bookings_count', 'is_blocked', 'notes'],
  bookings: ['booking_id', 'request_id', 'client_id', 'service_id', 'start_at', 'end_at', 'status', 'comment',
    'source', 'calendar_sync_status', 'calendar_sync_attempts', 'next_retry_at', 'calendar_last_error',
    'gcal_event_id', 'manage_token_ver', 'created_at', 'updated_at', 'cancelled_at', 'cancel_reason',
    'reminder_24_at', 'reminder_2_at'],
  bookings_archive: null,
  audit: ['ts', 'action', 'status', 'duration_ms', 'error_code', 'message', 'actor', 'phone_masked'],
  config: ['key', 'value']
};

var CONFIG_DEFAULTS = [
  ['timezone', 'Europe/Moscow'],
  ['calendar_id', 'primary'],
  ['web_app_url', ''],
  ['grid_min', '30'],
  ['min_slots_per_booking', '2'],
  ['max_slots_per_booking', '8'],
  ['buffer_after_min', '0'],
  ['lead_time_min', '120'],
  ['horizon_days', '30'],
  ['cancel_deadline_hours', '4'],
  ['max_active_per_client', '3'],
  ['master_email', ''],
  ['master_tg_chat_id', ''],
  ['notify_email_enabled', 'TRUE'],
  ['notify_telegram_enabled', 'FALSE'],
  ['gcal_color_id', '11'],
  ['gcal_summary_prefix', '[МАССАЖ]'],
  ['retention_months', '12'],
  ['master_phone', ''],
  ['dev_tg_chat_id', ''],   // этап 15.3: ошибки — разработчику в Telegram (узнать id — telegramFindChats())
  ['digest_hour', '20'],    // этап 15.3: час вечерней сводки мастеру «на завтра»
  ['backup_keep', '8']      // этап 15.6: сколько еженедельных копий таблицы хранить на Диске
];

function setup() {
  SCHEMA.bookings_archive = SCHEMA.bookings;
  var ss = SS();
  var log = [];

  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); log.push('создан лист ' + name); }
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, SCHEMA[name].length).setFontWeight('bold');
    } else {
      var added = Setup_addMissingColumns_(sh, SCHEMA[name]);
      if (added.length) log.push(name + ': добавлены колонки ' + added.join(', '));
    }
  });

  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('Лист1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  var existing = {};
  Sheet_readAll('config').forEach(function (r) { existing[r.key] = true; });
  CONFIG_DEFAULTS.forEach(function (kv) {
    if (!existing[kv[0]]) Sheet_append('config', { key: kv[0], value: kv[1] });
  });
  CFG_invalidate();

  if (Sheet_readAll('services').length === 0) {
    Sheet_append('services', { service_id: 'svc_massage_60', title: 'Массаж, 60 мин', duration_min: 60, buffer_after_min: 0, price: 3000, sort_order: 10, is_active: 'TRUE' });
    Sheet_append('services', { service_id: 'svc_massage_90', title: 'Массаж, 90 мин', duration_min: 90, buffer_after_min: 0, price: 4200, sort_order: 20, is_active: 'TRUE' });
    Sheet_append('services', { service_id: 'svc_massage_120', title: 'Массаж, 120 мин', duration_min: 120, buffer_after_min: 0, price: 5500, sort_order: 30, is_active: 'TRUE' });
    log.push('добавлены 3 услуги');
  }

  if (Sheet_readAll('schedule').length === 0) {
    for (var wd = 1; wd <= 7; wd++) {
      Sheet_append('schedule', {
        weekday: wd,
        is_working: wd <= 5 ? 'TRUE' : 'FALSE',
        start_time: '10:00',
        end_time: '20:00',
        note: ''
      });
    }
    log.push('добавлен график Пн–Пт 10:00–20:00');
  }

  var msg = 'setup() завершён. ' + (log.length ? log.join('; ') : 'структура уже существовала') +
    '\nДалее: setupSecrets("ваш PIN"), затем installTriggers().';
  console.log(msg);
  return msg;
}

/**
 * Этап 15.4: новые колонки дописываются в конец шапки существующего листа.
 * Данные не двигаются; повторный вызов ничего не меняет.
 */
function Setup_addMissingColumns_(sh, cols) {
  var width = sh.getLastColumn();
  var head = width ? sh.getRange(1, 1, 1, width).getValues()[0].map(String) : [];
  var added = [];
  cols.forEach(function (col) {
    if (head.indexOf(col) >= 0) return;
    head.push(col);
    sh.getRange(1, head.length).setValue(col);
    added.push(col);
  });
  return added;
}

/** Генерирует и записывает все секреты. openssl и ручные хеши не нужны. */
function setupSecrets(pin) {
  if (!/^\d{4,8}$/.test(String(pin || ''))) throw new Error('PIN должен быть числом из 4–8 цифр');
  var rnd = function (n) {
    var a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    var s = '';
    for (var i = 0; i < n; i++) s += a.charAt(Math.floor(Math.random() * a.length));
    return s;
  };
  PROP_set('ADMIN_SALT', rnd(32));
  PROP_set('ADMIN_TOKEN_SECRET', rnd(48));
  PROP_set('MANAGE_TOKEN_SECRET', rnd(48));
  PROP_set('ADMIN_PIN_HASH', Security_hashPin(pin));
  var msg = 'Секреты созданы. PIN для входа в админку: ' + pin + '. Сохраните его — восстановить нельзя, только сбросить повторным вызовом.';
  console.log(msg);
  return msg;
}

/** Вызвать после публикации веб-приложения: подставляет exec-URL в config. */
function setWebAppUrl(url) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(String(url || ''))) {
    throw new Error('Ожидается exec-URL вида https://script.google.com/macros/s/.../exec');
  }
  CFG_set('web_app_url', url);
  return 'web_app_url сохранён: ' + url;
}

/** Смена календаря. syncToken привязан к календарю и обязан быть сброшен. */
function switchCalendar(calendarId) {
  CFG_set('calendar_id', calendarId || 'primary');
  PROP_del('CAL_SYNC_TOKEN');
  PROP_del('CAL_LAST_SYNC_AT');
  return 'Календарь переключён на ' + (calendarId || 'primary') + ', syncToken сброшен. Ближайший тик выполнит полную загрузку.';
}

/** Отзыв согласия на обработку ПД, 152-ФЗ. */
function gdprForget(phone) {
  var p = Phone_normalize(phone);
  var c = Clients_findByPhone(p);
  if (!c) return 'Клиент с телефоном ' + Mask_phone(p) + ' не найден';
  var stub = '+7000000' + String(Date.now()).slice(-4);
  var now = new Date();
  Bookings_all(true).forEach(function (b) {
    if (b.client_id !== c.client_id) return;
    if (b.status === 'confirmed' && parseIsoStrict(b.start_at) > now) {
      Bookings_setStatus(b.booking_id, 'cancelled_by_master', 'gdpr_forget');
    }
    if (b.gcal_event_id) {
      try {
        CalExport_patch({ summary: '[МАССАЖ] Удалено', description: 'Данные клиента удалены по запросу.' }, b.gcal_event_id);
      } catch (e) { }
    }
    Bookings_update(b.booking_id, { comment: '' });
  });
  Sheet_update('clients', 'client_id', c.client_id, { name: 'Удалено', phone: stub, identity_ref: '', tg_chat_id: '', notes: '' });
  return 'Клиент обезличен. Будущие записи отменены, события календаря очищены.';
}

function resetTestData() {
  ['bookings', 'clients', 'blocks', 'busy_events', 'audit'].forEach(function (n) {
    var sh = SH(n);
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  });
  PROP_del('CAL_SYNC_TOKEN');
  Bookings_invalidate();
  return 'Тестовые данные очищены, syncToken сброшен.';
}
