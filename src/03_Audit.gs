/** Журнал и маскирование ПД. В лист audit не попадают полные телефоны, id и комментарии. */

function Audit_log(action, status, durationMs, errorCode, message, actor, phone) {
  try {
    Sheet_append('audit', {
      ts: nowIso(),
      action: action || '',
      status: status || '',
      duration_ms: durationMs || 0,
      error_code: errorCode || '',
      message: String(message || '').slice(0, 300),
      actor: actor || '',
      phone_masked: phone ? Mask_phone(phone) : ''
    });
  } catch (e) {
    console.error('Audit_log failed: ' + e.message);
  }
}

function Mask_phone(p) {
  var d = String(p || '').replace(/\D/g, '');
  if (d.length !== 11) return '***';
  return '+7 (' + d.slice(1, 4) + ') ***-**-' + d.slice(9);
}

function Mask_name(n) {
  var parts = String(n || '').trim().split(/\s+/);
  if (!parts[0]) return '***';
  return parts.length < 2 ? parts[0] : parts[0] + ' ' + parts[1][0] + '.';
}

function Mask_id(id) {
  var s = String(id || '');
  return s.length < 8 ? '***' : s.slice(0, 4) + '***' + s.slice(-3);
}

function Audit_rotate(maxRows, cutRows) {
  var sh = SH('audit');
  if (sh.getLastRow() - 1 <= maxRows) return 0;
  sh.deleteRows(2, cutRows);
  return cutRows;
}
