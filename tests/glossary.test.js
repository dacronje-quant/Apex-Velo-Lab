// Plain-English glossary (js/velo-glossary.js): every key the app uses exists, and meanings stay short.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const G = require('../js/velo-glossary.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('every glossary key used in the markup and the scripts exists', () => {
  const used = new Set();
  const html = read('index.html');
  for (const m of html.matchAll(/data-term(?:-short|-tip)?="([^"]+)"/g)) used.add(m[1]);
  for (const f of fs.readdirSync(path.join(root, 'js')).filter(n => n.endsWith('.js'))) {
    for (const m of read(`js/${f}`).matchAll(/VeloGlossary\.(?:html|tip|plain)\('([^']+)'/g)) used.add(m[1]);
  }
  // Keys passed through maps (tiles, KPIs, ride review cells).
  for (const k of ['ftp', 'ctl', 'ef', 'peak20', 'rhr', 'hrv', 'tss', 'kj', 'np', 'gap', 'vi', 'aboveCp', 'wdepl', 'matches', 'trimp', 'kcal', 'if', 'cadence', 'lr']) used.add(k);
  const missing = [...used].filter(k => !G.TERMS[k]);
  assert.deepEqual(missing, []);
  assert.ok(used.size >= 30, `${used.size} keys in use`);
});

test('meanings are short plain English and table versions are shorter', () => {
  for (const [key, t] of Object.entries(G.TERMS)) {
    if (key === 'gap') continue;
    const words = t.plain.split(/\s+/).length;
    assert.ok(words <= 7, `${key}: "${t.plain}" has ${words} words`);
    assert.ok(t.name, `${key} has a full name for the tooltip`);
    if (t.short) assert.ok(t.short.length < t.plain.length, `${key} short form is shorter`);
  }
  assert.equal(G.plain('tss'), 'Workout load score');
  assert.match(G.html('cp'), /^<span class="plain">Your long-effort limit<\/span>$/);
  assert.equal(G.html('nope'), '');
  assert.equal(G.tip('gap'), '');
});
