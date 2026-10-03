// Scan only files destined for the working-tree release; never print credential values.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = [...new Set(cp.execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/))];
const findings = [];
for (const relative of files) {
  const file = path.join(root, relative); if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  if (/^(?:\.env(?!\.example$)|\.strava-tokens|\.private-review\/|data\/(?!README\.md$|sample_sweetspot_ride\.tcx$)|test-output\/|node_modules\/)/.test(relative)) findings.push(relative + ': private runtime file');
  if (/\.(?:js|cjs|html|md|ps1|json|bat|yml|yaml)$/.test(relative) || relative === '.env.example') {
    const s = fs.readFileSync(file, 'utf8');
    if (/(?:sk-ant-[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(s)) findings.push(relative + ': possible credential');
    if (/C:[/\\]Users[/\\]dacro/i.test(s)) findings.push(relative + ': maintainer-specific path');
    if (relative === '.env.example' && /^(?:ANTHROPIC_API_KEY|GEMINI_API_KEY|STRAVA_CLIENT_ID|STRAVA_CLIENT_SECRET)=\S+/m.test(s)) findings.push(relative + ': populated credential template');
  }
}
if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
else console.log('Tracked release contents: no private runtime files, recognised credential patterns or maintainer paths. Git history requires a separate review.');
