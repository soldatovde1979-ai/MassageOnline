/**
 * 41_TelegramAdapter.gs — VERSION 1.1 (29.09.2026)
 *
 * Telegram Bot API: отправка сообщений и проверка подписи initData Mini App.
 * Было 1.0: заглушка. Сигнатуры сохранены — 40_Notify.gs и 21_Identity.gs не меняются.
 *
 * Токен: один бот на всё (решение Р-4 в my-FT) — свойство TELEGRAM_CLIENT_BOT_TOKEN,
 * запасной вариант — TELEGRAM_BOT_TOKEN (имя из ранних версий).
 */

var TG_INITDATA_MAX_AGE_SEC = 86400; // подпись Mini App живёт сутки

function Telegram_token_() {
  return PROP('TELEGRAM_CLIENT_BOT_TOKEN') || PROP('TELEGRAM_BOT_TOKEN') || '';
}

/**
 * Отправить сообщение.
 * opts (необязательно): { html: true — разметка HTML; silent: true — без звука;
 *   buttons: [[{ text, url } | { text, web_app_url }]] — кнопки под сообщением }.
 * Возвращает ответ Bot API или null, если Telegram не настроен или недоступен.
 * Никогда не бросает исключение: уведомление не должно ронять основную операцию.
 */
function Telegram_sendMessage(chatId, text, opts) {
  opts = opts || {};
  var token = Telegram_token_();
  if (!token || !chatId) {
    console.log('Telegram не настроен: ' + String(text).slice(0, 80));
    return null;
  }
  var body = {
    chat_id: String(chatId),
    text: String(text).slice(0, 4096),
    disable_web_page_preview: true
  };
  if (opts.html) body.parse_mode = 'HTML';
  if (opts.silent) body.disable_notification = true;
  if (opts.buttons && opts.buttons.length) {
    body.reply_markup = {
      inline_keyboard: opts.buttons.map(function (row) {
        return row.map(function (b) {
          return b.web_app_url ? { text: b.text, web_app: { url: b.web_app_url } } : { text: b.text, url: b.url };
        });
      })
    };
  }
  try {
    var resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify(body)
    });
    var out = JSON.parse(resp.getContentText());
    if (!out.ok) console.error('Telegram sendMessage: ' + out.description);
    return out;
  } catch (e) {
    console.error('Telegram sendMessage упал: ' + e.message);
    return null;
  }
}

/** Экранирование для parse_mode = HTML. */
function Telegram_escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Проверка initData Mini App по алгоритму Telegram:
 *   secret = HMAC_SHA256(ключ "WebAppData", сообщение bot_token)
 *   hash   = hex(HMAC_SHA256(ключ secret, сообщение data_check_string))
 * data_check_string — все поля, кроме hash, по алфавиту, "key=value" через перевод строки.
 * Возвращает { id, first_name, last_name, username, auth_date } или null.
 */
function Telegram_verifyInitData(initData) {
  var token = Telegram_token_();
  if (!token || !initData) return null;
  try {
    var fields = {}, hash = '';
    String(initData).split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      var k = Telegram_decode_(i < 0 ? pair : pair.slice(0, i));
      var v = i < 0 ? '' : Telegram_decode_(pair.slice(i + 1));
      if (k === 'hash') hash = v; else fields[k] = v;
    });
    if (!hash) return null;

    var dcs = Object.keys(fields).sort().map(function (k) { return k + '=' + fields[k]; }).join('\n');
    var secret = Utilities.computeHmacSha256Signature(token, 'WebAppData');
    var sig = Utilities.computeHmacSha256Signature(Utilities.newBlob(dcs).getBytes(), secret);
    if (Telegram_hex_(sig) !== String(hash).toLowerCase()) return null;

    var authDate = parseInt(fields.auth_date, 10) || 0;
    if (!authDate || (Date.now() / 1000 - authDate) > TG_INITDATA_MAX_AGE_SEC) return null;

    var user = JSON.parse(fields.user || '{}');
    if (!user.id) return null;
    return {
      id: user.id,
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      username: user.username || '',
      auth_date: authDate
    };
  } catch (e) {
    console.error('Telegram_verifyInitData: ' + e.message);
    return null;
  }
}

/** Как URLSearchParams: "+" — пробел, затем %XX. */
function Telegram_decode_(s) { return decodeURIComponent(String(s).replace(/\+/g, ' ')); }

/** Байты подписи GAS (знаковые -128..127) → hex. */
function Telegram_hex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var v = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out += (v < 16 ? '0' : '') + v.toString(16);
  }
  return out;
}
