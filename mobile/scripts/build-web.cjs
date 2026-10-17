// Builds mobile/www/ for Capacitor from the desktop app in the repository root, unchanged except for
// two tags added to index.html: the Android layer (src/, bundled) and its stylesheet.
// The PC-only parts (server.js, live.html, sw.js, tests, docs, tools) are left out.
const fs = require('node:fs'), path = require('node:path');
const esbuild = require('esbuild');

const mobile = path.resolve(__dirname, '..');
const root = path.resolve(mobile, '..');
const www = path.join(mobile, 'www');
const COPY = ['index.html', 'manifest.json', 'apex-velo-icon.png', 'apex-velo-icon-192.png', 'apex-velo-icon.ico', 'css', 'js', 'vendor'];

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(path.join(www, 'mobile'), { recursive: true });
for (const item of COPY) fs.cpSync(path.join(root, item), path.join(www, item), { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(mobile, 'src', 'index.js')],
  outfile: path.join(www, 'mobile', 'apex-native.js'),
  bundle: true, format: 'iife', target: ['chrome89'], legalComments: 'none', logLevel: 'warning'
});
fs.copyFileSync(path.join(mobile, 'web', 'apex-native.css'), path.join(www, 'mobile', 'apex-native.css'));

const indexPath = path.join(www, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const inject = (anchor, tag) => {
  const at = html.indexOf(anchor);
  if (at < 0) throw new Error(`build-web: "${anchor}" not found in index.html - update scripts/build-web.cjs`);
  html = html.slice(0, at) + tag + '\n  ' + html.slice(at);
};
// Before the first app script, so navigator.bluetooth and the /api/ routes exist from the start and the
// layer's DOMContentLoaded handler runs before js/app.js creates the app.
inject('<script src="vendor/chart.umd.min.js"></script>', '<script src="mobile/apex-native.js"></script>');
inject('</head>', '<link rel="stylesheet" href="mobile/apex-native.css">');
fs.writeFileSync(indexPath, html);
console.log(`build-web: ${path.relative(root, www)} ready`);
