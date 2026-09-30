const { createGas } = require('./gas-emulator');
const g = createGas();
const c = g.ctx;
console.log('files:', g.files.length);
console.log(c.setup ? 'setup exists' : 'no setup');
let r = c.setup(); console.log('setup:', typeof r === 'string' ? r.slice(0,200) : JSON.stringify(r).slice(0,200));
c.setupSecrets('1234');
const out = c.runSelfTests(); console.log('selftests:', String(out).slice(0,1500));
