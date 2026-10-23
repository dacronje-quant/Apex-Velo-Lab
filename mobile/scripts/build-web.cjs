// Builds mobile/www/ for Capacitor from the desktop app in the repository root, unchanged except for
// four tags added to index.html: the Android layer (src/, bundled) and its stylesheets.
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

/**
 * The token broker URL (broker/README.md): APEX_BROKER_URL when set and non-empty, else "brokerUrl" in app-config.json; empty means the
 * rider's own Strava API application. https only: the phone sends sign-in codes and refresh tokens there.
 */
function brokerUrl() {
  let url = process.env.APEX_BROKER_URL; // CI passes an unset repository variable as ''
  if (!url) {
    const file = path.join(mobile, 'app-config.json');
    url = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).brokerUrl : '';
  }
  url = String(url || '').trim().replace(/\/+$/, '');
  if (url && !/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(url)) throw new Error(`build-web: the broker URL must be https://... (got "${url}")`);
  return url;
}
const BROKER_URL = brokerUrl();

esbuild.buildSync({
  define: { __APEX_BROKER_URL__: JSON.stringify(BROKER_URL) },
  entryPoints: [path.join(mobile, 'src', 'index.js')],
  outfile: path.join(www, 'mobile', 'apex-native.js'),
  bundle: true, format: 'iife', target: ['chrome89'], legalComments: 'none', logLevel: 'warning'
});
for (const css of ['apex-native.css', 'apex-shell.css', 'apex-ride.css', 'apex-progress.css']) fs.copyFileSync(path.join(mobile, 'web', css), path.join(www, 'mobile', css));

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
inject('</head>', '<link rel="stylesheet" href="mobile/apex-shell.css">');
inject('</head>', '<link rel="stylesheet" href="mobile/apex-ride.css">');
inject('</head>', '<link rel="stylesheet" href="mobile/apex-progress.css">');
fs.writeFileSync(indexPath, html);
console.log(`build-web: ${path.relative(root, www)} ready (Strava sign-in: ${BROKER_URL ? `broker ${BROKER_URL}` : 'own API application'})`);
