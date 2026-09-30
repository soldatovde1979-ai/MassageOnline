/** Конфигурация: лист config (кэш 300 c) + Script Properties. */

var TZ_CACHE_ = null;

function CFG_all() {
  var c = CacheService.getScriptCache().get('cfg');
  if (c) return JSON.parse(c);
  var o = {};
  Sheet_readAll('config').forEach(function (r) { o[String(r.key)] = r.value; });
  CacheService.getScriptCache().put('cfg', JSON.stringify(o), 300);
  return o;
}

function CFG(key) {
  var v = CFG_all()[key];
  if (v === undefined || v === '') {
    throw apiError('INTERNAL', 'Ключ "' + key + '" не найден в листе config. Выполните setup().');
  }
  return String(v);
}

function CFG_opt(key, def) {
  var v = CFG_all()[key];
  return (v === undefined || v === '') ? def : String(v);
}

function CFG_INT(key) {
  var n = parseInt(CFG(key), 10);
  if (isNaN(n)) throw apiError('INTERNAL', 'Ключ "' + key + '" в листе config не число');
  return n;
}

function CFG_BOOL(key) {
  var v = String(CFG_opt(key, 'FALSE')).toUpperCase();
  return v === 'TRUE' || v === '1' || v === 'ДА';
}

function CFG_set(key, value) {
  if (Sheet_findRow('config', 'key', key) > 0) Sheet_update('config', 'key', key, { value: value });
  else Sheet_append('config', { key: key, value: value });
  CFG_invalidate();
}

function CFG_invalidate() {
  CacheService.getScriptCache().remove('cfg');
  TZ_CACHE_ = null;
}

function TZ() {
  if (!TZ_CACHE_) TZ_CACHE_ = CFG_opt('timezone', 'Europe/Moscow');
  return TZ_CACHE_;
}

function PROP(key) { return PropertiesService.getScriptProperties().getProperty(key); }
function PROP_set(key, val) { PropertiesService.getScriptProperties().setProperty(key, val); }
function PROP_del(key) { PropertiesService.getScriptProperties().deleteProperty(key); }
