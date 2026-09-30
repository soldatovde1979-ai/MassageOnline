/**
 * 32_Outbox.gs — VERSION 1.1 (29.09.2026): отменённая до публикации бронь не попадает в календарь.
 */
/** Transactional Outbox: публикация в календарь вне критической секции, с backoff. */

function flushOutbox() {
  var t0 = Date.now();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;
  var done = 0, failed = 0;
  try {
    var batch = Bookings_outboxBatch(20);
    Outbox_flushBlocks_();
    batch.forEach(function (b) {
      try {
        // Отмена могла случиться раньше, чем бронь попала в календарь (статус pending без события):
        // такую бронь публиковать нельзя — иначе в календаре мастера появится запись-призрак.
        var cancelled = b.status === 'cancelled_by_client' || b.status === 'cancelled_by_master';
        if (b.calendar_sync_status === 'deleting' || cancelled) {
          if (b.gcal_event_id) CalExport_remove(b.gcal_event_id);
          Bookings_update(b.booking_id, { calendar_sync_status: 'synced', calendar_last_error: '' });
        } else {
          var client = Clients_get(b.client_id);
          var svc = Services_get(b.service_id);
          if (!client) throw apiError('INTERNAL', 'Клиент брони не найден');
          var payload = buildEventPayload(b, client, svc);
          var ev = b.gcal_event_id ? CalExport_patch(payload, b.gcal_event_id) : CalExport_insert(payload);
          Bookings_update(b.booking_id, {
            gcal_event_id: ev.id,
            calendar_sync_status: 'synced',
            calendar_last_error: '',
            next_retry_at: ''
          });
          if (!b.gcal_event_id) Notify_send('booking_created', { booking: b });
        }
        done++;
      } catch (err) {
        failed++;
        Outbox_fail_(b, err);
      }
    });
    if (done || failed) {
      Audit_log('flushOutbox', 'OK', Date.now() - t0, '', 'успешно: ' + done + ', ошибок: ' + failed, 'trigger');
    }
  } finally {
    lock.releaseLock();
  }
}

function Outbox_fail_(b, err) {
  var attempts = parseInt(b.calendar_sync_attempts || 0, 10) + 1;
  var patch = {
    calendar_sync_attempts: attempts,
    calendar_last_error: String(err && err.message || err).slice(0, 250)
  };
  if (attempts >= 5) {
    patch.calendar_sync_status = 'failed';
    Bookings_update(b.booking_id, patch);
    Notify_send('calendar_sync_failed', { booking: Bookings_get(b.booking_id), error: patch.calendar_last_error });
    return;
  }
  patch.next_retry_at = iso(addMin(new Date(), Math.min(Math.pow(2, attempts), 30)));
  Bookings_update(b.booking_id, patch);
}

/** Публикация ручных блокировок мастера, если включён флаг push_to_calendar. */
function Outbox_flushBlocks_() {
  Blocks_all().forEach(function (bl) {
    if (String(bl.push_to_calendar).toUpperCase() !== 'TRUE') return;
    if (bl.gcal_event_id) return;
    try {
      var ev = CalExport_insert(buildBlockPayload(bl));
      Blocks_update(bl.block_id, { gcal_event_id: ev.id });
    } catch (err) {
      console.error('block export failed: ' + err.message);
    }
  });
}
