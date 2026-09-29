/** Сборка payload события. Точная реализация раздела 3 ТЗ. */

function buildEventPayload(booking, client, service) {
  return {
    summary: CFG('gcal_summary_prefix') + ' ' + client.name + ' — ' + Phone_format(client.phone),
    description:
      'Клиент: ' + client.name + '\n' +
      'Телефон: ' + Phone_format(client.phone) + '\n' +
      'Услуга: ' + (service ? service.title : booking.service_id) + '\n' +
      'Комментарий: ' + (booking.comment || '—') + '\n' +
      'Ссылка на управление: ' + Security_buildManageUrl(booking),
    start: { dateTime: booking.start_at, timeZone: TZ() },
    end: { dateTime: booking.end_at, timeZone: TZ() },
    colorId: CFG('gcal_color_id'),
    transparency: 'opaque',
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
    extendedProperties: {
      private: {
        booking_id: booking.booking_id,
        created_via: 'massage_booking_app',
        client_id: client.client_id,
        service_id: booking.service_id
      }
    }
  };
}

function buildBlockPayload(block) {
  return {
    summary: CFG('gcal_summary_prefix') + ' Занято' + (block.reason ? ' — ' + block.reason : ''),
    description: 'Личная блокировка, создана в сервисе записи.',
    start: { dateTime: block.start_at, timeZone: TZ() },
    end: { dateTime: block.end_at, timeZone: TZ() },
    colorId: '8',
    transparency: 'opaque',
    extendedProperties: { private: { block_id: block.block_id, created_via: 'massage_booking_app' } }
  };
}

function CalExport_insert(payload) { return Calendar.Events.insert(payload, CFG('calendar_id')); }
function CalExport_patch(payload, eventId) { return Calendar.Events.patch(payload, CFG('calendar_id'), eventId); }

function CalExport_remove(eventId) {
  try {
    Calendar.Events.remove(CFG('calendar_id'), eventId);
  } catch (err) {
    var s = String(err);
    if (s.indexOf('404') === -1 && s.indexOf('410') === -1 && s.indexOf('Not Found') === -1) throw err;
  }
  return true;
}
