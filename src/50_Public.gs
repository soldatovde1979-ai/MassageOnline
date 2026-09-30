function Api_servicesList() {
  return {
    ok: true,
    data: {
      timezone: TZ(),
      horizon_days: CFG_INT('horizon_days'),
      min_slots: parseInt(CFG_opt('min_slots_per_booking', '2'), 10),
      max_slots: parseInt(CFG_opt('max_slots_per_booking', '8'), 10),
      services: Services_list(true).map(function (s) {
        return { service_id: s.service_id, title: s.title };
      })
    }
  };
}

function Api_availabilityGet(req) {
  var p = req.payload || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date_from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(p.date_to || '')) {
    throw apiError('BAD_SLOT', 'Некорректный диапазон дат');
  }
  return { ok: true, data: Availability_forRange(p.date_from, p.date_to, p.service_id, p.duration_min) };
}

function Api_bookingCreate(req) {
  var p = req.payload || {};
  if (!req.request_id) throw apiError('BAD_REQUEST', 'Отсутствует request_id');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw apiError('BUSY', 'Сервис занят, повторите через несколько секунд');
  try {
    var existing = Bookings_findByRequestId(req.request_id);
    if (existing) {
      var c0 = Clients_get(existing.client_id);
      var out0 = Bookings_toPublic(existing);
      out0.client_echo = c0 ? { client_id: c0.client_id, name: c0.name, phone: c0.phone } : null;
      return { ok: true, data: out0, idempotent_replay: true };
    }

    var svc = Services_get(p.service_id);
    if (!svc || !svc.is_active) throw apiError('BAD_SERVICE', 'Услуга недоступна');

    var start = parseIsoStrict(p.start_at);
    if (!isOnGrid(start, GRID_MIN)) throw apiError('BAD_SLOT', 'Начало должно попадать на сетку 30 минут');

    // Длительность выбирает клиент числом слотов по 30 минут. Границы — из конфига.
    var minSlots = parseInt(CFG_opt('min_slots_per_booking', '2'), 10);
    var maxSlots = parseInt(CFG_opt('max_slots_per_booking', '8'), 10);
    var slots = parseInt(p.slots_count, 10) || Math.round(svc.duration_min / GRID_MIN);
    if (slots < minSlots) throw apiError('BAD_SLOT', 'Минимум ' + minSlots + ' слота подряд');
    if (slots > maxSlots) throw apiError('BAD_SLOT', 'Максимум ' + maxSlots + ' слотов за одну запись');

    // end_at считается СЕРВЕРОМ, присланное клиентом значение игнорируется
    var durationMin = slots * GRID_MIN;
    var end = addMin(start, durationMin);

    // Проверка на всю длительность разом: если внутри есть занятый слот,
    // такого стартового времени в выдаче просто не будет.
    var free = Availability_forDay(dateOf(start), durationMin, true);
    var startIso = iso(start);
    var ok = free.some(function (s) { return s.start === startIso; });
    if (!ok) throw apiError('SLOT_TAKEN', 'Это время только что заняли. Выберите другое');

    var identity = Identity_resolve(p);
    var client = Clients_upsert(identity);

    var maxActive = parseInt(CFG_opt('max_active_per_client', '3'), 10);
    if (Bookings_activeCountForClient(client.client_id) >= maxActive) {
      throw apiError('BAD_REQUEST', 'У вас уже есть ' + maxActive + ' активные записи. Отмените одну из них');
    }

    var booking = Bookings_insert({
      booking_id: Utils_uuid(),
      request_id: req.request_id,
      client_id: client.client_id,
      service_id: svc.service_id,
      start_at: startIso,
      end_at: iso(end),
      status: 'confirmed',
      comment: String(p.comment || '').slice(0, 500),
      source: p.source || 'web',
      calendar_sync_status: 'pending',
      gcal_event_id: '',
      created_at: nowIso()
    });

    var out = Bookings_toPublic(booking);
    out.client_echo = { client_id: client.client_id, name: client.name, phone: client.phone };
    return { ok: true, data: out };
  } finally {
    lock.releaseLock();
  }
}
