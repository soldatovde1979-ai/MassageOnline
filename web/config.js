/* config.js — VERSION 1.0 (29.09.2026)
 * Единственный файл витрины, который правится при развёртывании.
 * APP_MAJOR обязан совпадать с мажором app_v1.js и с <meta name="mb-app-major"> в index.html —
 * при расхождении приложение не запустится и покажет, что обновить.
 */
window.MB_CONFIG = {
  APP_MAJOR: 1,
  // 'demo' — работает без сервера, записи ненастоящие (для показа и проверки).
  // Боевой режим — exec-URL веб-приложения Apps Script, например:
  // 'https://script.google.com/macros/s/AKfy.../exec'
  API_URL: 'demo'
};
