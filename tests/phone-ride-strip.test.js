const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Viewport } = require('../js/velo-live-graph.js');

// Exercise the actual canvas renderers with recorded drawing calls.
function renderer(reduceMotion = true) {
  const html = fs.readFileSync('live.html', 'utf8');
  const graph = html.slice(html.indexOf('  const STEP_LIGHT ='), html.indexOf('  function renderRide('));
  const strip = html.slice(html.indexOf('  function drawZoneBar('), html.indexOf('  /** Left-leg share'));
  const elements = Object.fromEntries(['trGraph','zoneBar','rideGraphView','rideGraphMode'].map(id => [id,{id,dataset:{},textContent:''}]));
  const canvases = {};
  for (const id of ['trGraph','zoneBar']) {
    const calls = [];
    const g = new Proxy({ calls, createLinearGradient: () => ({ addColorStop() {} }) }, {
      get(target,key) { return key in target ? target[key] : (...args) => calls.push({ name:key,args }); }
    });
    canvases[id] = { g, w:360, h:id==='trGraph'?240:20 };
  }
  const camera = new Viewport({reduceMotion});
  const context = vm.createContext({window:{},performance:{now:()=>0},page:0,rideViewport:camera,
    $:id=>elements[id],ctx2d:el=>canvases[el.id],fmt:t=>String(t),zoneColor:()=> '#2a86ff'});
  vm.runInContext(graph + strip + '\nthis.renderGraph=drawRideGraph;this.renderBar=drawZoneBar;',context);
  const snapshot = {ftp:185,bias:100,profile:[[600,50],[1200,95],[1800,70]],step:{index:2},hist:{p:[],h:[],c:[],bin:1}};
  const draw = now => {
    Object.values(canvases).forEach(c=>{c.g.calls.length=0;});
    context.renderGraph(snapshot,.5,now);
  };
  return {context,camera,elements,canvases,snapshot,draw};
}

test('following graph reuses the existing strip and preserves plot height', () => {
  const r=renderer();r.draw(0);
  const fullPlayhead=r.canvases.trGraph.g.calls.filter(c=>c.name==='fillRect').at(-1);
  r.camera.setMode('follow',0);r.draw(0);
  const calls=r.canvases.trGraph.g.calls;
  assert.equal(calls.filter(c=>c.name==='fillRect').at(-1).args[3],fullPlayhead.args[3]);
  assert(!calls.some(c=>c.name==='fillRect'&&c.args[1]>=220),'no miniature bar painted inside the graph');
  assert.equal(r.elements.zoneBar.dataset.view,'follow');
  assert.equal(Number(r.elements.zoneBar.dataset.end)-Number(r.elements.zoneBar.dataset.start),360);
  assert.equal(r.elements.zoneBar.dataset.start,r.elements.rideGraphView.dataset.start);
  assert.equal(r.canvases.zoneBar.g.calls.filter(c=>c.name==='strokeRect').length,1,'window outlined on existing strip');
});

test('returning to full view and leaving Ride clear the strip window', () => {
  const r=renderer();r.camera.setMode('follow',0);r.draw(0);
  r.camera.setMode('full',0);r.draw(0);
  assert.equal(r.elements.zoneBar.dataset.view,'full');
  assert(!r.canvases.zoneBar.g.calls.some(c=>c.name==='strokeRect'));
  r.camera.setMode('follow',0);r.draw(0);r.context.page=1;
  r.canvases.zoneBar.g.calls.length=0;r.context.renderBar(r.snapshot,.5);
  assert.equal(r.elements.zoneBar.dataset.view,'full');
  assert(!r.canvases.zoneBar.g.calls.some(c=>c.name==='strokeRect'));
});

test('paused zoom keeps the strip aligned through the transition and on short workouts', () => {
  const r=renderer(false);r.draw(0);r.camera.setMode('follow',0);
  for(const time of [0,240,480]) {
    r.draw(time);
    assert.equal(r.elements.zoneBar.dataset.start,r.elements.rideGraphView.dataset.start);
    assert.equal(r.elements.zoneBar.dataset.end,r.elements.rideGraphView.dataset.end);
  }
  r.snapshot.profile=[[120,50]];r.camera.reset();r.draw(600);
  assert.equal(r.elements.zoneBar.dataset.start,'0.00');
  assert.equal(r.elements.zoneBar.dataset.end,'120.00');
});
