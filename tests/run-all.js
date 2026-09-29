/**
 * run-all.js — VERSION 1.0 (29.09.2026)
 * Все тесты одной командой перед clasp push: node tests/run-all.js
 * Код выхода 1, если хоть один тест упал — push делать нельзя.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const files = ['admin-bookings.test.js', 'admin-ui.e2e.js', 'stage15-2.test.js', 'web-client.e2e.js'];
let failed = 0;
files.forEach((f) => {
  const full = path.join(__dirname, f);
  try {
    const out = execFileSync(process.execPath, [full], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const line = (out.match(/Итог:.*$/m) || ['(нет итога)'])[0];
    console.log(f.padEnd(26) + line);
  } catch (e) {
    failed++;
    const out = String(e.stdout || '') + String(e.stderr || '');
    console.log(f.padEnd(26) + 'УПАЛ');
    out.split('\n').filter((l) => /FAIL|Error|Итог/.test(l)).slice(0, 15).forEach((l) => console.log('   ' + l));
  }
});
console.log(failed ? '\nЕсть падения — clasp push не делать.' : '\nВсе тесты прошли.');
process.exit(failed ? 1 : 0);
