/**
 * 52_AdminRules.gs — VERSION 1.0 (29.09.2026, этап 15.5)
 * Экран «Правила записи»: мастер меняет ключи config сама, без таблицы.
 * Меняются только ключи из списка ниже и только в допустимых границах.
 *
 * Файл назван 52_*: ROUTES в 53_Router.gs ссылается на эти функции при загрузке (ревью, п. 1.3).
 */

/** key — ключ config; unit — как значение показывается мастеру; mul — множитель unit → значение в config. */
var ADMIN_RULES = [
  { key: 'buffer_after_min', title: 'Перерыв между клиентами', unit: 'мин', mul: 1, allowed: [0, 30, 60], def: 0 },
  { key: 'lead_time_min', title: 'Записаться не позже чем за', unit: 'ч', mul: 60, min: 0, max: 48, def: 2 },
  { key: 'cancel_deadline_hours', title: 'Отменить или перенести не позже чем за', unit: 'ч', mul: 1, min: 0, max: 72, def: 4 },
  { key: 'horizon_days', title: 'Запись открыта вперёд на', unit: 'дн', mul: 1, min: 7, max: 120, def: 30 },
  { key: 'max_bookings_per_day', title: 'Не больше сеансов в день (0 — без лимита)', unit: 'шт', mul: 1, min: 0, max: 12, def: 0 }
];

function AdminRules_view_() {
  return ADMIN_RULES.map(function (r) {
    var raw = parseInt(CFG_opt(r.key, String(r.def * r.mul)), 10);
    var v = isNaN(raw) ? r.def : raw / r.mul;
    var out = { key: r.key, title: r.title, unit: r.unit, value: v };
    if (r.allowed) out.allowed = r.allowed; else { out.min = r.min; out.max = r.max; }
    return out;
  });
}

/** admin.rulesGet → {rules: [{key, title, unit, value, allowed | min+max}]} */
function Api_adminRulesGet(req) {
  Admin_auth_(req);
  return { ok: true, data: { rules: AdminRules_view_() } };
}

/** admin.rulesSet — payload {values: {key: число в единицах мастера}}. Сначала проверяются все, потом пишутся. */
function Api_adminRulesSet(req) {
  Admin_auth_(req);
  var values = (req.payload || {}).values || {};
  var writes = [];
  Object.keys(values).forEach(function (k) {
    var r = ADMIN_RULES.filter(function (x) { return x.key === k; })[0];
    if (!r) throw apiError('BAD_REQUEST', 'Неизвестное правило: ' + k);
    var v = Number(values[k]);
    if (!isFinite(v) || Math.floor(v) !== v) throw apiError('BAD_REQUEST', r.title + ': нужно целое число');
    if (r.allowed ? r.allowed.indexOf(v) < 0 : (v < r.min || v > r.max)) {
      throw apiError('BAD_REQUEST', r.title + ': допустимо ' + (r.allowed ? r.allowed.join(', ') : 'от ' + r.min + ' до ' + r.max) + ' ' + r.unit);
    }
    writes.push([r.key, String(v * r.mul)]);
  });
  if (!writes.length) throw apiError('BAD_REQUEST', 'Нечего сохранять');
  writes.forEach(function (w) { CFG_set(w[0], w[1]); });
  return { ok: true, data: { rules: AdminRules_view_() } };
}
