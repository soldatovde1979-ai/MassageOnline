function Api_bookingGet(req) {
  var b = Security_verifyManageToken(req.auth && req.auth.token);
  var data = Bookings_toPublic(b);
  data.cancel_deadline_hours = CFG_INT('cancel_deadline_hours');
  data.can_cancel = (parseIsoStrict(b.start_at).getTime() - Date.now()) > CFG_INT('cancel_deadline_hours') * 3600000;
  return { ok: true, data: data };
}

function Api_bookingCancel(req) {
  var b = Security_verifyManageToken(req.auth && req.auth.token);
  if (b.status !== 'confirmed') throw apiError('NOT_FOUND', 'Запись уже отменена');
  Manage_assertDeadline_(b);
  Bookings_setStatus(b.booking_id, 'cancelled_by_client', 'client_request');
  Notify_send('booking_cancelled_by_client', { booking: Bookings_get(b.booking_id) });
  return { ok: true, data: { booking_id: b.booking_id, status: 'cancelled_by_client' } };
}

function Api_bookingReschedule(req) {
  var b = Security_verifyManageToken(req.auth && req.auth.token);
  if (b.status !== 'confirmed') throw apiError('NOT_FOUND', 'Запись уже отменена');
  Manage_assertDeadline_(b);

  var durationMin = Math.round(
    (parseIsoStrict(b.end_at).getTime() - parseIsoStrict(b.start_at).getTime()) / 60000
  );
  var start = parseIsoStrict((req.payload || {}).start_at);
  if (!isOnGrid(start, GRID_MIN)) throw apiError('BAD_SLOT', 'Начало должно попадать на сетку 30 минут');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw apiError('BUSY', 'Сервис занят, повторите через несколько секунд');
  try {
    // Освобождаем старое время, чтобы перенос внутри того же дня не конфликтовал сам с собой
    Bookings_update(b.booking_id, { status: 'rescheduling' });
    var free = Availability_forDay(dateOf(start), durationMin, true);
    var startIso = iso(start);
    if (!free.some(function (s) { return s.start === startIso; })) {
      Bookings_update(b.booking_id, { status: 'confirmed' });
      throw apiError('SLOT_TAKEN', 'Этот слот только что заняли. Выберите другое время');
    }
    Bookings_update(b.booking_id, {
      status: 'confirmed',
      start_at: startIso,
      end_at: iso(addMin(start, durationMin)),
      manage_token_ver: parseInt(b.manage_token_ver || 1, 10) + 1,
      calendar_sync_status: 'pending',
      calendar_sync_attempts: 0,
      next_retry_at: ''
    });
  } finally {
    lock.releaseLock();
  }
  return { ok: true, data: Bookings_toPublic(Bookings_get(b.booking_id)) };
}

function Manage_assertDeadline_(b) {
  var left = parseIsoStrict(b.start_at).getTime() - Date.now();
  if (left < CFG_INT('cancel_deadline_hours') * 3600000) {
    throw apiError('TOO_LATE', 'Отмена возможна не позднее чем за ' + CFG_INT('cancel_deadline_hours') + ' ч. Позвоните мастеру');
  }
}
