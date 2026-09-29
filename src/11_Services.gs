function Services_list(activeOnly) {
  var rows = Sheet_readAll('services');
  if (activeOnly !== false) rows = rows.filter(function (s) { return String(s.is_active).toUpperCase() === 'TRUE'; });
  rows.forEach(function (s) {
    s.duration_min = parseInt(s.duration_min, 10);
    s.buffer_after_min = parseInt(s.buffer_after_min || 0, 10);
    s.price = parseInt(s.price || 0, 10);
    s.is_active = String(s.is_active).toUpperCase() === 'TRUE';
  });
  return rows.sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
}

function Services_get(id) {
  var all = Services_list(false);
  for (var i = 0; i < all.length; i++) if (all[i].service_id === id) return all[i];
  return null;
}
