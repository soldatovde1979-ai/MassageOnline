/** HMAC-токены управления записью и админ-сессии, PIN и троттлинг попыток. */

function Sec_hmac_(msg, secret) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(msg, secret)).replace(/=+$/, '');
}

function Sec_sha256_(s) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s)).replace(/=+$/, '');
}

function Sec_secret_(name) {
  var v = PROP(name);
  if (!v) throw apiError('INTERNAL', 'Секрет ' + name + ' не задан. Выполните setupSecrets("ваш PIN").');
  return v;
}

function Security_buildManageToken(booking) {
  var exp = Math.floor(parseIsoStrict(booking.start_at).getTime() / 1000) + 30 * 86400;
  var ver = booking.manage_token_ver || 1;
  return booking.booking_id + '.' + exp + '.' +
    Sec_hmac_(booking.booking_id + '|' + exp + '|' + ver, Sec_secret_('MANAGE_TOKEN_SECRET'));
}

function Security_buildManageUrl(booking) {
  var base = CFG_opt('web_app_url', '');
  if (!base) return '(не задан config.web_app_url)';
  return base + '?r=manage&t=' + encodeURIComponent(Security_buildManageToken(booking));
}

function Security_verifyManageToken(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 3) throw apiError('UNAUTHORIZED', 'Ссылка недействительна');
  var bookingId = parts[0], exp = parseInt(parts[1], 10), sig = parts[2];
  if (!exp || exp * 1000 < Date.now()) throw apiError('TOKEN_EXPIRED', 'Срок действия ссылки истёк');
  var b = Bookings_get(bookingId);
  if (!b) throw apiError('NOT_FOUND', 'Запись не найдена');
  var expected = Sec_hmac_(bookingId + '|' + exp + '|' + (b.manage_token_ver || 1), Sec_secret_('MANAGE_TOKEN_SECRET'));
  if (expected !== sig) throw apiError('UNAUTHORIZED', 'Ссылка недействительна');
  return b;
}

function Security_issueAdminToken() {
  var exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  return 'admin.' + exp + '.' + Sec_hmac_('admin|' + exp, Sec_secret_('ADMIN_TOKEN_SECRET'));
}

function Security_verifyAdminToken(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'admin') throw apiError('UNAUTHORIZED', 'Требуется вход');
  var exp = parseInt(parts[1], 10);
  if (!exp || exp * 1000 < Date.now()) throw apiError('TOKEN_EXPIRED', 'Сессия истекла, войдите заново');
  if (Sec_hmac_('admin|' + exp, Sec_secret_('ADMIN_TOKEN_SECRET')) !== parts[2]) {
    throw apiError('UNAUTHORIZED', 'Требуется вход');
  }
  return true;
}

function Security_hashPin(pin) {
  return Sec_sha256_(String(pin) + Sec_secret_('ADMIN_SALT'));
}

function Security_checkPin(pin) {
  var cache = CacheService.getScriptCache();
  if (cache.get('pin_block')) throw apiError('UNAUTHORIZED', 'Слишком много попыток. Попробуйте через 15 минут');
  if (Security_hashPin(pin) === Sec_secret_('ADMIN_PIN_HASH')) {
    cache.remove('pin_fail');
    return true;
  }
  var fails = parseInt(cache.get('pin_fail') || '0', 10) + 1;
  cache.put('pin_fail', String(fails), 900);
  if (fails >= 5) {
    cache.put('pin_block', '1', 900);
    cache.remove('pin_fail');
    throw apiError('UNAUTHORIZED', 'Слишком много попыток. Вход заблокирован на 15 минут');
  }
  throw apiError('UNAUTHORIZED', 'Неверный PIN. Осталось попыток: ' + (5 - fails));
}
