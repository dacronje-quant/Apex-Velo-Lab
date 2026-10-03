// Isolated UI regression: commands are intercepted; no trainer or live server is contacted.
const { chromium } = require('C:/Users/dacro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const snapshot = { state:'running', title:'Threshold progression — sustained climbing preparation', ftp:185, bias:100,
  target:176,baseTarget:176,targetPct:95,power:178,power5:177,powerAverages:{3:178,5:177,7:176,10:175},hr:153,hrZone:'Z3 Tempo',cadence:91,targetCadence:90,
  avgPower:162,distanceKm:18.4,elapsed:2010,totalDuration:3600,progress:2010/3600,profile:[[300,50],[300,65],[600,95],[180,50],[600,95],[180,50],[600,95],[840,50]],
  hist:{p:[],h:[],c:[],bin:3},trace:Array.from({length:120},(_,i)=>176+Math.sin(i)*8),step:{index:5,count:8,name:'Sustained threshold with controlled cadence',duration:600,remaining:390},
  next:{name:'Easy recovery before the next threshold effort',duration:180,watts:93},devices:{trainer:true,pedals:true,hr:true},
  targetZone:{short:'Z4',color:'#fbbf24'},zone:{color:'#fbbf24'},balanceLeft:49.4,wbal:{kj:10.2,pct:68,state:'burning',tte:180},
  hw:{bluetooth:true,list:['trainer','pedals','hr','fan'].map(kind=>({kind,label:kind,state:'connected',known:true,battery:82,canCalibrate:kind==='pedals',reading:kind==='fan'?{mode:'hr',speed:62}:{watts:178,cadence:91,hr:153,left:49.4}}))} };
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try {
  const context=await browser.newContext({reducedMotion:'reduce'});
  const errors=[],commands=[];let seq=1;
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.hostname!=='phone-layout.local') return route.abort();
   if(u.pathname==='/api/live') { await new Promise(r=>setTimeout(r,80));return route.fulfill({json:{snapshot,ageMs:0,seq:seq++}}); }
   if(u.pathname.startsWith('/api/')) {commands.push({url:u.pathname,body:route.request().postData()});return route.fulfill({json:{ok:true}});}
   const file=path.resolve(root,u.pathname.slice(1));
   if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
   const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2','.png':'image/png','.ico':'image/x-icon'};
   return route.fulfill({body:fs.readFileSync(file),contentType:types[path.extname(file)]||'application/octet-stream'});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://phone-layout.local/live.html');
  await page.waitForFunction(()=>document.getElementById('trPower').textContent==='178');
  await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.locator('#tabs button').count(),3);
  assert.equal(await page.locator('.pedaling-views').count(),1);
  assert.equal(await page.locator('.view-modes').count(),0);
  const issues=[];
  for(const [width,height] of [[390,844],[430,932],[360,740],[320,568],[844,390]]) {
   await page.setViewportSize({width,height});
   for(const destination of [0,3,5]) {await page.locator('#tabs [data-page="'+destination+'"]').click();await inspect('view-'+destination);if(destination===3){for(const view of [0,1]){await page.locator('[data-pedal-view="'+view+'"]').click();await inspect('pedal-'+view);}}}
   assert.equal(await page.locator('#devList .dcard:visible').count(),4);
   async function inspect(view) {
    const problems=await page.evaluate(()=>{
     const visible=e=>!e.closest('[hidden]')&&e.getBoundingClientRect().width>0;
     return [...document.querySelectorAll('.page,.mode-panel')].filter(visible).filter(e=>e.scrollHeight>e.clientHeight+2||e.scrollWidth>e.clientWidth+2).map(e=>({id:e.id,h:e.clientHeight,sh:e.scrollHeight,w:e.clientWidth,sw:e.scrollWidth}));
    });
    problems.forEach(problem=>issues.push({width,height,view,...problem}));
   }
  }
  await page.locator('#tabs [data-page="5"]').click();
  await page.locator('.fan-settings-button').click();
  assert.equal(await page.locator('#fanSettings').isVisible(),true);
  await page.locator('#closeFanSettings').click();
  assert.equal(await page.locator('#fanSettings').isVisible(),false);
  await page.setViewportSize({width:390,height:844});await page.locator('#tabs [data-page="0"]').click();
  // Let the inherited selection transitions settle before recording the screenshot.
  await page.waitForTimeout(350);
  await page.screenshot({path:path.join(root,'test-output/phone-ride.png')});
  snapshot.power = 1234;
  await page.waitForFunction(()=>document.getElementById('trPower').textContent==='1234');
  assert.equal(await page.locator('#trPower').getAttribute('class'),'tv num four-digits');
  snapshot.power = 178;
  const commandResponse=page.waitForResponse(r=>r.url().endsWith('/api/live/cmd'));await page.locator('#btnUp').click();await commandResponse;assert.ok(commands.some(c=>c.body?.includes('watts-up')),'nudge command sent');
  // Zen is a display choice, with live data and the same guarded ride commands.
  snapshot.power=218;snapshot.target=222;snapshot.targetPct=120;snapshot.hr=169;snapshot.cadence=97;snapshot.targetCadence=98;
  snapshot.hist={bin:1,p:Array(60).fill(218),h:Array.from({length:60},(_,i)=>168+Math.sin(i/6)*2),c:Array.from({length:60},(_,i)=>97+Math.sin(i)*1.5)};
  await page.waitForFunction(()=>document.getElementById('trPower').textContent==='218');
  await page.waitForTimeout(4500); // Let the earlier unacknowledged mock nudge expire.
  const beforeZen=commands.length;
  await page.locator('#btnZen').click();
  assert.equal(await page.locator('#phoneZen').isVisible(),true);
  assert.equal(await page.locator('#zenPower').textContent(),'218');
  assert.equal(await page.locator('#zenHr').textContent(),'169');
  assert.equal(await page.locator('#zenWbal').textContent(),'68%');
  assert.equal(await page.locator('body').getAttribute('data-zone'),'z5');
  assert.equal(commands.length,beforeZen,'entering Zen sends no ride command');
  for(const [width,height] of [[390,844],[430,932],[360,740],[320,568],[844,390],[578,329]]) {
   await page.setViewportSize({width,height});
   const problems=await page.evaluate(()=>[document.documentElement,document.getElementById('phoneZen'),...document.querySelectorAll('.zen-dashboard,.zen-left,.zen-metrics,.zen-card,.zen-actions')].filter(e=>e.scrollHeight>e.clientHeight+2||e.scrollWidth>e.clientWidth+2).map(e=>({id:e.id||e.className,h:e.clientHeight,sh:e.scrollHeight,w:e.clientWidth,sw:e.scrollWidth})));
   problems.forEach(problem=>issues.push({width,height,view:'zen',...problem}));
   if(width===390||width===578)await page.screenshot({path:path.join(root,'test-output/phone-zen-'+(width===390?'portrait':'landscape')+'.png')});
  }
  snapshot.power=1234;
  await page.waitForFunction(()=>document.getElementById('zenPower').textContent==='1234');
  assert.equal(await page.locator('#zenPower').getAttribute('class'),'four-digits');
  assert.equal(await page.locator('body').getAttribute('data-zone'),'z7');
  await page.locator('#zenPowerView').click();
  assert.ok((await page.locator('#zenPowerLabel').textContent()).includes('3s'),'averaging shared with Ride');
  await page.locator('#zenSkip').click();
  assert.equal(await page.locator('#zenSkip').textContent(),'Confirm');
  const skipResponse=page.waitForResponse(r=>r.url().endsWith('/api/live/cmd'));
  await page.locator('#zenSkip').click();await skipResponse;
  assert.ok(commands.some(c=>c.body?.includes('"skip"')),'two-tap skip delegated');
  const pauseResponse=page.waitForResponse(r=>r.url().endsWith('/api/live/cmd'));
  await page.locator('#zenToggle').click();await pauseResponse;
  assert.ok(commands.some(c=>c.body?.includes('"toggle"')),'pause delegated');
  snapshot.state='paused';snapshot.wbal=null;snapshot.hr=null;snapshot.cadence=null;
  await page.waitForFunction(()=>document.getElementById('zenState').textContent==='PAUSED'&&document.getElementById('zenHr').textContent==='--');
  assert.equal(await page.locator('#zenHr').textContent(),'--');
  assert.equal(await page.locator('#zenWbalSub').textContent(),'No CP model');
  const beforeExit=commands.length;
  await page.locator('#zenExit').click();
  assert.equal(await page.locator('#phoneZen').isVisible(),false);
  assert.equal(await page.locator('#tabs [data-page="0"]').getAttribute('aria-selected'),'true');
  assert.equal(commands.length,beforeExit,'exiting Zen sends no ride command');
  await page.locator('#btnZen').click();await page.keyboard.press('Escape');
  assert.equal(await page.locator('#btnZen').evaluate(e=>document.activeElement===e),true,'exit restores focus');
  await page.locator('#btnZen').click();
  snapshot.state='finished';snapshot.easySpinOffer=20;
  await page.waitForFunction(()=>document.getElementById('zenState').textContent==='FINISHED');
  assert.equal(await page.locator('#zenToggle').isDisabled(),true,'finished ride cannot restart from Zen');
  assert.equal(await page.locator('#spinOffer').isVisible(),true,'easy-spin offer remains accessible');
  await page.locator('#zenExit').click();
  delete snapshot.easySpinOffer;
  snapshot.state='running';snapshot.power=178;
  for(let i=0;i<4;i++)await page.locator('#btnPowerView').click(); // 3s -> 5s -> 7s -> 10s -> Current.
  await page.locator('#tabs [data-page="3"]').click();await page.reload();await page.waitForFunction(()=>document.getElementById('trPower').textContent==='178');
  assert.equal(await page.locator('#tabs [data-page="3"]').getAttribute('aria-selected'),'true');
  // Migrate the old dedicated Pedal tab into the remembered Stroke view.
  await page.evaluate(()=>{localStorage.setItem('apexLivePage3','4');localStorage.removeItem('apexLivePedalMode');});
  await page.reload();await page.waitForFunction(()=>document.getElementById('trPower').textContent==='178');
  assert.equal(await page.locator('#tabs [data-page="3"]').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('[data-pedal-view="1"]').getAttribute('aria-pressed'),'true');
  assert.deepEqual(errors,[],'no browser errors');
  if(issues.length)console.log(JSON.stringify(issues,null,2));
  assert.deepEqual(issues,[],'every visible phone view fits without scrolling');
  console.log('Passed: Ride, Pedaling, Devices and Zen; no scrolling across 31 layouts; live zones, averaging, two-tap skip, pause, exit and missing sensors.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
