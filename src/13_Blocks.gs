function Blocks_all() { return Sheet_readAll('blocks'); }

function Blocks_forRange(fromDate, toDate_) {
  return Blocks_all().filter(function (b) {
    return overlaps(parseIsoStrict(b.start_at), parseIsoStrict(b.end_at), fromDate, toDate_);
  });
}

function Blocks_forDay(dateISO) {
  var d = dayBounds(dateISO);
  return Blocks_forRange(d.start, d.end);
}

function Blocks_get(id) {
  var all = Blocks_all();
  for (var i = 0; i < all.length; i++) if (all[i].block_id === id) return all[i];
  return null;
}

function Blocks_insert(o) {
  o.block_id = o.block_id || 'bl_' + Utilities.getUuid().slice(0, 8);
  o.created_at = nowIso();
  Sheet_append('blocks', o);
  return o;
}

function Blocks_delete(id) { return Sheet_delete('blocks', 'block_id', id); }
function Blocks_update(id, patch) { return Sheet_update('blocks', 'block_id', id, patch); }
