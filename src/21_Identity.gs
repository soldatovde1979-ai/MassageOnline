/**
 * ЕДИНСТВЕННАЯ точка определения клиента.
 * Прямое обращение к payload.client из другой бизнес-логики запрещено.
 */

function Identity_resolve(payload) {
  var provider = 'local';

  // Phase 2: если пришёл Telegram initData — проверяем подпись и доверяем ей.
  if (payload && payload.tg_init_data && CFG_BOOL('notify_telegram_enabled')) {
    var tg = Telegram_verifyInitData(payload.tg_init_data);
    if (tg) {
      return {
        client_id: '',
        name: String(payload.client && payload.client.name || tg.first_name || '').trim(),
        phone: Phone_normalize(payload.client && payload.client.phone),
        provider: 'telegram',
        identity_ref: String(tg.id)
      };
    }
  }

  var c = (payload && payload.client) || {};

  var name = String(c.name || '').trim();
  if (name.length < 2) throw apiError('BAD_REQUEST', 'Укажите имя');

  return {
    client_id: String(c.client_id || '') || Utils_uuid(),
    name: name.slice(0, 60),
    phone: Phone_normalize(c.phone),
    provider: provider,
    identity_ref: String(c.client_id || '')
  };
}
