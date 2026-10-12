// Expand test filenames ourselves for consistent behavior across Windows and Unix shells.
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'tests')).filter(n => n.endsWith('.test.js')).sort().map(n => 'tests/' + n);
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', env: process.env });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
