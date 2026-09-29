/** Канонический ключ клиента — нормализованный телефон, а не client_id из браузера. */

function Phone_normalize(raw) {
  var d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  if (d.length !== 11 || d[0] !== '7') throw apiError('BAD_PHONE', 'Некорректный номер телефона');
  return '+' + d;
}

function Phone_format(p) {
  var d = String(p || '').replace(/\D/g, '');
  if (d.length !== 11) return String(p || '');
  return '+7 ' + d.slice(1, 4) + ' ' + d.slice(4, 7) + '-' + d.slice(7, 9) + '-' + d.slice(9);
}

function Clients_all() { return Sheet_readAll('clients'); }

function Clients_get(id) {
  var all = Clients_all();
  for (var i = 0; i < all.length; i++) if (all[i].client_id === id) return all[i];
  return null;
}

function Clients_findByPhone(phone) {
  var all = Clients_all();
  for (var i = 0; i < all.length; i++) if (String(all[i].phone) === phone) return all[i];
  return null;
}

function Clients_upsert(identity) {
  var found = Clients_findByPhone(identity.phone);
  if (found) {
    if (String(found.is_blocked).toUpperCase() === 'TRUE') {
      throw apiError('UNAUTHORIZED', 'Запись недоступна. Свяжитесь с мастером');
    }
    Sheet_update('clients', 'client_id', found.client_id, {
      name: identity.name || found.name,
      last_seen_at: nowIso(),
      bookings_count: (parseInt(found.bookings_count || 0, 10) + 1)
    });
    found.name = identity.name || found.name;
    return found;
  }
  var row = {
    client_id: identity.client_id || Utils_uuid(),
    phone: identity.phone,
    name: identity.name,
    identity_provider: identity.provider || 'local',
    identity_ref: identity.identity_ref || '',
    tg_chat_id: '',
    consent_at: nowIso(),
    first_seen_at: nowIso(),
    last_seen_at: nowIso(),
    bookings_count: 1,
    is_blocked: 'FALSE'
  };
  Sheet_append('clients', row);
  return row;
}
