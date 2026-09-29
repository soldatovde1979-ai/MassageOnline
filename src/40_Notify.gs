/** Единый интерфейс уведомлений. Канал выбирается флагами конфига. */

function Notify_send(kind, payload) {
  try {
    var msg = Notify_render_(kind, payload);
    if (!msg) return;
    if (CFG_BOOL('notify_email_enabled')) {
      var to = CFG_opt('master_email', '');
      if (to) MailApp.sendEmail({ to: to, subject: msg.subject, body: msg.body });
    }
    if (CFG_BOOL('notify_telegram_enabled')) {
      Telegram_sendMessage(CFG_opt('master_tg_chat_id', ''), msg.subject + '\n\n' + msg.body);
    }
  } catch (e) {
    console.error('Notify_send(' + kind + ') failed: ' + e.message);
  }
}

function Notify_render_(kind, p) {
  var b = p && p.booking;
  var when = b ? (fmtDM(parseIsoStrict(b.start_at)) + ' ' + fmtHM(parseIsoStrict(b.start_at)) + '–' + fmtHM(parseIsoStrict(b.end_at))) : '';
  var client = b ? Clients_get(b.client_id) : null;
  var who = client ? (client.name + ', ' + Phone_format(client.phone)) : '';
  var svc = b ? Services_get(b.service_id) : null;

  switch (kind) {
    case 'booking_created':
      return {
        subject: 'Новая запись: ' + when,
        body: who + '\n' + (svc ? svc.title : '') + '\n' +
          'Комментарий: ' + (b.comment || '—') + '\n\nАдминка: ' + CFG_opt('web_app_url', '') + '?r=admin'
      };
    case 'booking_cancelled_by_client':
      return { subject: 'Отмена клиентом: ' + when, body: who + '\n' + (svc ? svc.title : '') };
    case 'booking_cancelled_externally':
      return {
        subject: 'Запись отменена по удалению события: ' + when,
        body: who + '\nКлиент об отмене не уведомлён — позвоните ему.'
      };
    case 'calendar_sync_failed':
      return {
        subject: 'Запись не попала в календарь: ' + when,
        body: who + '\nОшибка: ' + (p.error || '') + '\nВнесите событие в календарь вручную.'
      };
    case 'daily_digest':
      return { subject: 'Записи на сегодня: ' + p.count, body: p.text || 'Записей нет' };
    default:
      return null;
  }
}

function Notify_masterDailyDigest() {
  var today = dateOf(new Date());
  var items = Bookings_activeForDay(today, true).sort(function (a, b) { return a.start_at < b.start_at ? -1 : 1; });
  var text = items.map(function (b) {
    var c = Clients_get(b.client_id);
    var svc = Services_get(b.service_id);
    return fmtHM(parseIsoStrict(b.start_at)) + '–' + fmtHM(parseIsoStrict(b.end_at)) + '  ' +
      (c ? c.name + ' ' + Phone_format(c.phone) : '') + '  ' + (svc ? svc.title : '');
  }).join('\n');
  Notify_send('daily_digest', { count: items.length, text: text });
}
