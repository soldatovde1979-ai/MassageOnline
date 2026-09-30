/**
 * 40_Notify.gs — VERSION 1.1 (30.09.2026, этап 15.3)
 * Единый интерфейс уведомлений. Канал выбирается флагами конфига.
 *
 * 1.1: Telegram мастеру — HTML и кнопки «Открыть день» / «Написать в Telegram»; телефон в тексте кликабелен
 *      (кнопку «Позвонить» Telegram не допускает: в кнопках только http(s) и tg://).
 *      Запись, которую мастер создала сама, уведомление не шлёт. Перенос клиентом — новое уведомление.
 *      Ошибки (календарь не принял запись, INTERNAL) — разработчику в dev_tg_chat_id, а не мастеру (ревью, п. 5.4).
 *      Сводка — вечером «на завтра» (Notify_eveningDigest) вместо утренней «на сегодня» (ревью, п. 2.7).
 */

var DEV_ALERT_DEDUP_SEC = 1800; // одинаковая ошибка — не чаще раза в 30 минут

function Notify_send(kind, payload) {
  try {
    var msg = Notify_render_(kind, payload);
    if (!msg) return;
    if (msg.dev && CFG_opt('dev_tg_chat_id', '')) {
      Notify_dev(msg.subject + '\n' + msg.body);
      return;
    }
    if (CFG_BOOL('notify_email_enabled')) {
      var to = CFG_opt('master_email', '');
      if (to) MailApp.sendEmail({ to: to, subject: msg.subject, body: msg.body });
    }
    if (CFG_BOOL('notify_telegram_enabled')) {
      Telegram_sendMessage(CFG_opt('master_tg_chat_id', ''),
        '<b>' + Telegram_escapeHtml(msg.subject) + '</b>\n' + Telegram_escapeHtml(msg.body),
        { html: true, buttons: msg.buttons || [], silent: !!msg.silent });
    }
  } catch (e) {
    console.error('Notify_send(' + kind + ') failed: ' + e.message);
  }
}

/** Сообщение разработчику. Без dev_tg_chat_id — только в журнал выполнения. Никогда не бросает. */
function Notify_dev(text) {
  try {
    var chat = CFG_opt('dev_tg_chat_id', '');
    if (!chat) { console.error('DEV: ' + text); return; }
    var key = 'dev_' + Telegram_hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text))).slice(0, 32);
    var cache = CacheService.getScriptCache();
    if (cache.get(key)) return;
    cache.put(key, '1', DEV_ALERT_DEDUP_SEC);
    Telegram_sendMessage(chat, '⚠️ MassageOnline\n' + String(text).slice(0, 3500));
  } catch (e) {
    console.error('Notify_dev failed: ' + e.message);
  }
}

/** Ссылка на админку, открытую на нужном дне. */
function Notify_adminDayUrl_(dateISO) {
  var base = CFG_opt('web_app_url', '');
  return base ? base + '?r=admin&d=' + dateISO : '';
}

/** Кнопки под уведомлением о записи: день в админке и чат с клиентом. */
function Notify_bookingButtons_(b, client) {
  var row = [];
  var dayUrl = b ? Notify_adminDayUrl_(dateOf(parseIsoStrict(b.start_at))) : '';
  if (dayUrl) row.push({ text: 'Открыть день', url: dayUrl });
  var digits = client ? String(client.phone || '').replace(/\D/g, '') : '';
  if (digits.length === 11) row.push({ text: 'Написать в Telegram', url: 'https://t.me/+' + digits });
  return row.length ? [row] : [];
}

function Notify_render_(kind, p) {
  var b = p && p.booking;
  var when = b ? Notify_when_(b) : '';
  var client = b ? Clients_get(b.client_id) : null;
  var who = client ? (client.name + ', ' + Phone_format(client.phone)) : '';
  var note = client && client.notes ? '\n📝 ' + String(client.notes).slice(0, 200) : '';
  var buttons = Notify_bookingButtons_(b, client);

  switch (kind) {
    case 'booking_created':
      if (b.source === 'admin') return null; // мастер записала сама — ей сообщать не о чем
      return {
        subject: 'Новая запись: ' + when,
        body: who + (b.comment ? '\nКомментарий: ' + b.comment : '') + note,
        buttons: buttons
      };
    case 'booking_rescheduled_by_client':
      return {
        subject: 'Перенос: ' + when,
        body: who + '\nБыло: ' + Notify_when_({ start_at: p.from_start, end_at: p.from_end }),
        buttons: buttons
      };
    case 'booking_cancelled_by_client':
      return { subject: 'Отмена клиентом: ' + when, body: who, buttons: buttons };
    case 'booking_cancelled_externally':
      return {
        subject: 'Запись отменена по удалению события: ' + when,
        body: who + '\nКлиент об отмене не уведомлён — позвоните ему.',
        buttons: buttons
      };
    case 'calendar_sync_failed':
      return {
        dev: true,
        subject: 'Запись не попала в календарь: ' + when,
        body: who + '\nОшибка: ' + (p.error || '') + '\nВнесите событие в календарь вручную.',
        buttons: buttons
      };
    case 'evening_digest':
      return { subject: p.subject, body: p.text, buttons: p.buttons, silent: p.silent };
    default:
      return null;
  }
}

/** «пт 02.10 18:00–19:30» во времени мастера. */
function Notify_when_(b) {
  var s = parseIsoStrict(b.start_at), e = parseIsoStrict(b.end_at);
  var WD = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
  return WD[parseInt(Utilities.formatDate(s, TZ(), 'u'), 10)] + ' ' + fmtDM(s) + ' ' + fmtHM(s) + '–' + fmtHM(e);
}

/** Вечерняя сводка мастеру: «Завтра у тебя: …». Триггер — installTriggers(), час — config.digest_hour. */
function Notify_eveningDigest() {
  var tomorrow = dateOf(addDays(new Date(), 1));
  var items = Bookings_activeForDay(tomorrow, true).sort(function (a, b) { return a.start_at < b.start_at ? -1 : 1; });
  var dayUrl = Notify_adminDayUrl_(tomorrow);
  var head = 'Завтра, ' + Notify_when_({ start_at: iso(toDate(tomorrow, '12:00')), end_at: iso(toDate(tomorrow, '12:00')) }).split(' ').slice(0, 2).join(' ');
  var text = items.map(function (b) {
    var c = Clients_get(b.client_id);
    return fmtHM(parseIsoStrict(b.start_at)) + '–' + fmtHM(parseIsoStrict(b.end_at)) + '  ' +
      (c ? c.name + ', ' + Phone_format(c.phone) : '') +
      (b.comment ? '\n   ' + b.comment : '') +
      (c && c.notes ? '\n   📝 ' + String(c.notes).slice(0, 80) : '');
  }).join('\n');
  Notify_send('evening_digest', {
    subject: head + (items.length ? ': записей — ' + items.length : ': записей нет'),
    text: items.length ? text : 'Свободный день 🌿',
    buttons: dayUrl ? [[{ text: 'Открыть день', url: dayUrl }]] : [],
    silent: !items.length
  });
}
