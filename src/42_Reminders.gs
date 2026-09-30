/**
 * 42_Reminders.gs — VERSION 1.0 (30.09.2026, этап 15.3)
 * Напоминания клиентам в Telegram: за сутки и за 2 часа до записи (ревью, п. 3.6).
 *
 * Кому: клиентам с clients.tg_chat_id — он заполняется, когда клиент записывается из Telegram Mini App
 * (подпись initData проверена в Identity_resolve). Остальным напоминание не уходит — канала нет.
 * Когда: триггер sendReminders каждые 15 минут. Отметки bookings.reminder_24_at / reminder_2_at
 * не дают отправить дважды; перенос записи их сбрасывает.
 * Напоминание не шлётся, если запись создана уже внутри окна (записался за 5 часов — «за сутки» не нужно).
 */

var REMINDERS = [
  { col: 'reminder_24_at', beforeMin: 24 * 60, minLeftMin: 3 * 60 },
  { col: 'reminder_2_at', beforeMin: 2 * 60, minLeftMin: 0 }
];

function sendReminders() {
  if (!CFG_BOOL('notify_telegram_enabled')) return 0;
  var head = Sheet_head('bookings');
  if (head.indexOf('reminder_24_at') < 0) {
    Notify_dev('Напоминания не работают: в листе bookings нет колонок reminder_*. Выполните setup().');
    return 0;
  }
  var now = new Date(), sent = 0;
  var horizon = addMin(now, 24 * 60 + 30);
  Bookings_activeForRange(now, horizon, true).forEach(function (b) {
    var start = parseIsoStrict(b.start_at);
    var leftMin = (start - now) / 60000;
    var created = b.created_at ? parseIsoStrict(Bookings_isoCell_(b.created_at)) : new Date(0);
    REMINDERS.forEach(function (r) {
      if (b[r.col]) return;
      if (leftMin > r.beforeMin || leftMin <= r.minLeftMin) return;
      if (created > addMin(start, -r.beforeMin)) return;       // записался уже внутри окна
      var c = Clients_get(b.client_id);
      if (!c || !c.tg_chat_id) return;
      var out = Telegram_sendMessage(c.tg_chat_id, Reminders_text_(b, c, r), { html: true, buttons: Reminders_buttons_(b) });
      if (out && out.ok) {
        Bookings_update(b.booking_id, Reminders_patch_(r.col));
        b[r.col] = 'sent';
        sent++;
      }
    });
  });
  return sent;
}

function Reminders_patch_(col) { var p = {}; p[col] = nowIso(); return p; }

/** Сброс отметок при переносе — по новому времени напоминания уйдут заново. */
function Reminders_resetPatch() { return { reminder_24_at: '', reminder_2_at: '' }; }

function Reminders_text_(b, c, r) {
  var ty = CFG_opt('client_address_form', 'vy') === 'ty';
  var s = parseIsoStrict(b.start_at);
  var today = dateOf(new Date()), day = dateOf(s);
  var dayWord = day === today ? 'сегодня' : day === dateOf(addDays(new Date(), 1)) ? 'завтра' : Notify_when_(b).split(' ').slice(0, 2).join(' ');
  var master = CFG_opt('master_name', '');
  var first = String(c.name || '').split(' ')[0];
  var lines = [
    (first ? Telegram_escapeHtml(first) + ', н' : 'Н') + 'апоминаю: ' + dayWord + ' в <b>' + fmtHM(s) + '</b> — массаж' +
      (master ? ' у ' + Telegram_escapeHtml(master) : '') + '.'
  ];
  var addr = CFG_opt('studio_address', '');
  if (addr) lines.push('Адрес: ' + Telegram_escapeHtml(addr));
  var after = CFG_opt('studio_after_booking', '');
  if (after && r.col === 'reminder_2_at') lines.push(Telegram_escapeHtml(after));
  if (Reminders_buttons_(b).length) {
    lines.push(ty ? 'Если планы поменялись — перенеси или отмени запись по кнопке ниже.'
      : 'Если планы поменялись — перенесите или отмените запись по кнопке ниже.');
  } else {
    lines.push(ty ? 'Если не успеваешь — напиши или позвони мастеру.' : 'Если не успеваете — напишите или позвоните мастеру.');
  }
  return lines.join('\n');
}

/** Кнопка — только пока клиент ещё может сам перенести или отменить (cancel_deadline_hours). */
function Reminders_buttons_(b) {
  var left = parseIsoStrict(b.start_at).getTime() - Date.now();
  if (left < CFG_INT('cancel_deadline_hours') * 3600000) return [];
  var url = Security_buildManageUrl(b);
  return /^https:/.test(url) ? [[{ text: 'Перенести или отменить', url: url }]] : [];
}
