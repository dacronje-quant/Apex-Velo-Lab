// Isolated rendering audit: never contacts the rider's server or physical devices.
const { chromium } = require('C:/Users/dacro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'test-output/ui-review');
fs.mkdirSync(out, { recursive: true });
const snapshot = { state:'running', title:'Threshold progression — sustained climbing preparation', ftp:185, bias:100,
  target:176,baseTarget:176,targetPct:95,power:178,power5:177,hr:153,hrZone:'Z3 Tempo',cadence:91,targetCadence:90,
  elapsed:2010,totalDuration:3600,progress:2010/3600,profile:[[300,50],[300,65],[600,95],[180,50],[600,95],[180,50],[600,95],[840,50]],
  hist:{p:[],h:[],c:[],bin:3},trace:[],step:{index:5,count:8,name:'Sustained threshold with controlled cadence',duration:600,remaining:390},
  next:{name:'Easy recovery before the next threshold effort',duration:180,watts:93},devices:{trainer:true,pedals:true,hr:true},
  targetZone:{short:'Z4',color:'#fbbf24'},zone:{color:'#fbbf24'},balanceLeft:49.4 };
function audit() {
  const visible = el => { const r=el.getBoundingClientRect(), s=getComputedStyle(el); return r.width>0 && r.height>0 && s.visibility!=='hidden' && !el.closest('.modal-overlay:not(.open),.drawer-overlay:not(.open),.sr-only'); };
  const issues=[];
  for(const el of document.querySelectorAll('body *')) {
    if(!visible(el) || ['SCRIPT','STYLE','SVG','CANVAS','OPTION'].includes(el.tagName)) continue;
    if(document.body.classList.contains('zen-mode') && !el.closest('#zenCockpitOverlay')) continue;
    if(document.querySelector('.modal-overlay.open') && !el.closest('.modal-overlay.open')) continue;
    const s=getComputedStyle(el), r=el.getBoundingClientRect();
    if(el.closest('.pages') && !el.closest('.page')?.matches(`[data-review-active]`)) continue;
    if(el.tagName==='BUTTON' && ['hidden','clip'].includes(s.overflowX) && (el.scrollWidth>el.clientWidth+2 || el.scrollHeight>el.clientHeight+2)) {
      issues.push({kind:'control-clipped',selector:el.id?'#'+el.id:el.className,text:el.textContent.trim().slice(0,100),width:Math.round(r.width)});
    }
    const nodes=[...el.childNodes].filter(n=>n.nodeType===3&&n.textContent.trim());
    for(const n of nodes) {
      const range=document.createRange();range.selectNodeContents(n);
      const rects=[...range.getClientRects()];
      let clipped=null, scrollContainer=false;
      for(let p=el;p && p!==document.body;p=p.parentElement) {
        const ps=getComputedStyle(p), pr=p.getBoundingClientRect();
        if(['auto','scroll'].includes(ps.overflowX)) {scrollContainer=true;break;}
        if(['hidden','clip'].includes(ps.overflowX) && rects.some(t=>t.right>pr.right+2||t.left<pr.left-2)) { clipped=p;break; }
      }
      const outside=!scrollContainer && rects.some(t=>t.right>innerWidth+2||t.left<-2);
      const overrun= !['inline','contents'].includes(s.display) && rects.some(t=>t.right>r.right+2||t.left<r.left-2);
      if(clipped||outside||overrun) issues.push({kind:clipped?'clipped':outside?'outside':'overrun',selector:el.id?'#'+el.id:el.tagName.toLowerCase()+'.'+String(el.className).trim().replace(/\s+/g,'.'),text:n.textContent.trim().slice(0,100),width:Math.round(r.width),overflow:Math.round(el.scrollWidth-el.clientWidth),ellipsis:s.textOverflow==='ellipsis',ancestor:clipped?.className});
    }
  }
  return {pageWidth:innerWidth,scrollWidth:document.documentElement.scrollWidth,issues};
}
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try {
  const context=await browser.newContext({reducedMotion:'reduce'});
  const errors=[];
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.hostname!=='apex-review.local') return route.abort();
   if(u.pathname.startsWith('/api/')) {
     if(u.pathname.startsWith('/api/live')) { await new Promise(r=>setTimeout(r,100));return route.fulfill({json:{snapshot,ageMs:0,seq:1}}); }
     return route.fulfill({status:503,json:{error:'Isolated UI review — service unavailable'}});
   }
   const f=path.resolve(root,u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1)));
   if(!f.startsWith(root+path.sep)||!fs.existsSync(f)||!fs.statSync(f).isFile()||! /\.(html|js|css|woff2|png|ico|json)$/i.test(f))return route.fulfill({status:404,body:''});
   const types={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2','.png':'image/png','.json':'application/json'};
   return route.fulfill({body:fs.readFileSync(f),contentType:types[path.extname(f)]});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://apex-review.local/?apexTest=1');
  await page.waitForFunction(()=>window.app?.workoutLibrary?.length);
  await page.evaluate(()=>app.loadWorkoutObjectIntoCockpit(app.workoutLibrary.find(w=>w.intervals?.length>5)||app.workoutLibrary[0]));
  await page.evaluate(()=>document.fonts.ready);
  if(process.argv.includes('--inspect')) {
   await page.setViewportSize({width:320,height:568});await page.evaluate(()=>app.switchTab('analytics'));
   console.log(JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('#view-analytics *')].filter(el=>{
    const r=el.getBoundingClientRect();return r.width>0&&r.right>innerWidth+1&&!el.closest('.ana-nav,.table-scroll');
   }).map(el=>({selector:el.id||el.className,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width,minWidth:getComputedStyle(el).minWidth,text:el.textContent.trim().slice(0,50)}))),null,2));
   return;
  }
  const results=[];
  const interactions=[];
  const sizes=[[1920,1080],[1440,900],[1280,800],[1024,768],[900,700],[768,1024],[560,800],[430,932],[390,844],[360,800],[320,568],[844,390]];
  if(!process.argv.includes('--phone-only')) {
  for(const [width,height] of sizes) {
   await page.setViewportSize({width,height});
   for(const tab of ['cockpit','workouts','ai-coach','ask','analytics','history','calendar']) {
    await page.evaluate(t=>app.switchTab(t),tab);await page.waitForTimeout(60);
    results.push({surface:'app',view:tab,width,height,...await page.evaluate(audit)});
    if([1440,390,320,1024].includes(width))await page.screenshot({path:path.join(out,`app-${tab}-${width}.png`),fullPage:true});
   }
   for(const modal of ['settingsModal','hardwareModal','profileManagerModal']) {
    await page.evaluate(id=>id==='hardwareModal'?app.openHardwareLab():app.openModal(id),modal);await page.waitForTimeout(60);
    results.push({surface:'app',view:modal,width,height,...await page.evaluate(audit)});
    if(width===390)await page.screenshot({path:path.join(out,`${modal}-${width}.png`)});
    await page.evaluate(id=>app.closeModal(id),modal);
   }
   console.log(`App ${width}×${height} checked`);
  }
  for(const [width,height] of [[1440,900],[768,1024],[390,844],[320,568],[844,390]]) {
   await page.setViewportSize({width,height});
   await page.evaluate(()=>app.switchTab('cockpit'));
   await page.evaluate(()=>app.toggleZenMode());await page.waitForTimeout(80);
   results.push({surface:'zen',view:'cockpit',width,height,...await page.evaluate(audit)});
   await page.screenshot({path:path.join(out,`zen-${width}.png`)});
   await page.evaluate(()=>app.toggleZenMode());
   for(const section of ['ai','health','backups','phone','guide']) {
    await page.evaluate(section=>{app.openModal('settingsModal');app.showSettingsSection(section);},section);
    results.push({surface:'settings',view:section,width,height,...await page.evaluate(audit)});
    await page.evaluate(()=>app.closeModal('settingsModal'));
   }
   await page.evaluate(()=>app.switchTab('calendar'));
   for(const preset of ['1month','ytd','all']) {
    const button=page.locator(`#calPresetPills [data-preset="${preset}"]`);
    if(await button.count()) {
     await button.click();results.push({surface:'calendar',view:preset,width,height,...await page.evaluate(audit)});
    }
   }
  }
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{
   app.loadWorkoutObjectIntoCockpit({id:'ui-review-long',name:'Threshold progression — sustained climbing preparation with longer recovery',category:'threshold',intervals:[
    {name:'Sustained threshold with controlled cadence and a smooth finish',duration:900,pctFtp:95,cadence:90},
    {name:'Easy recovery before the next threshold effort',duration:300,pctFtp:50,cadence:85}]});
  });
  await page.waitForTimeout(80);
  results.push({surface:'stress',view:'long-workout',width:390,height:844,...await page.evaluate(audit)});
  await page.screenshot({path:path.join(out,'long-workout-390.png'),fullPage:true});
  for(const tab of ['cockpit','workouts','ai-coach','ask','analytics','history','calendar']) {
   await page.setViewportSize({width:768,height:1024});
   await page.evaluate(tab=>app.switchTab(tab),tab);
   await page.evaluate(()=>{const fonts=[...document.querySelectorAll('body *')].filter(el=>!['SCRIPT','STYLE','SVG','CANVAS'].includes(el.tagName)).map(el=>[el,parseFloat(getComputedStyle(el).fontSize)]);fonts.forEach(([el,size])=>{el.dataset.reviewFont=el.style.fontSize;el.style.fontSize=(size*1.5)+'px';});});
   results.push({surface:'large-text',view:tab,width:768,height:1024,...await page.evaluate(audit)});
   if(tab==='analytics')await page.screenshot({path:path.join(out,'large-text-analytics.png'),fullPage:true});
   await page.evaluate(()=>document.querySelectorAll('[data-review-font]').forEach(el=>{el.style.fontSize=el.dataset.reviewFont;delete el.dataset.reviewFont;}));
  }
  await page.evaluate(()=>app.switchTab('cockpit'));await page.locator('#btnHeaderZenMode').focus();
  const before=await page.evaluate(()=>app.intervalIndex);await page.keyboard.press('Tab');
  interactions.push({check:'Tab preserves the current interval',passed:before===await page.evaluate(()=>app.intervalIndex)});
  await page.locator('#btnOpenSettings').focus();await page.evaluate(()=>app.openModal('settingsModal'));
  interactions.push({check:'Settings moves focus inside the dialog',passed:await page.evaluate(()=>!!document.activeElement.closest('#settingsModal'))});
  await page.evaluate(()=>app.closeModal('settingsModal'));
  }
  await page.goto('http://apex-review.local/live.html');await page.waitForFunction(()=>document.getElementById('trPower').textContent==='178');
  const phoneSizes=process.argv.includes('--phone-only')?[[390,844],[844,390]]:sizes.filter(([w])=>w<=1024);
  for(const [width,height] of phoneSizes) {
   await page.setViewportSize({width,height});
   // Phone views: Ride (0), Pedaling (3, Balance then Stroke model) and Devices (5).
   for(const [i,pedal] of [[0,null],[3,0],[3,1],[5,null]]) {
    await page.locator(`[data-page="${i}"]`).click();
    if(pedal!==null) await page.locator(`[data-pedal-view="${pedal}"]`).click();
    await page.waitForTimeout(900);
    results.push({surface:'phone',view:pedal===null?String(i):i+'-'+pedal,width,height,...await page.evaluate(audit)});
    if([390,320,844].includes(width))await page.screenshot({path:path.join(out,`phone-${pedal===null?i:i+'-'+pedal}-${width}.png`)});
   }
   console.log(`Phone ${width}×${height} checked`);
  }
  for(const [width,height] of [[390,844],[844,390]]) {
   await page.setViewportSize({width,height});await page.locator('[data-page="0"]').click();await page.waitForTimeout(900);
   await page.locator('#pages').evaluate(el=>el.scrollTo({left:0,behavior:'instant'}));
   if(await page.locator('#rideGraphView').getAttribute('data-view')==='follow')await page.locator('#rideGraphView').click();
   const originalHeight=await page.locator('#rideGraphView').evaluate(el=>el.getBoundingClientRect().height);
   await page.locator('#rideGraphView').click();
   await page.waitForFunction(()=>document.getElementById('zoneBar').dataset.view==='follow');
   const check=await page.evaluate(()=>{
    const graph=document.getElementById('rideGraphView'),bar=document.getElementById('zoneBar');
    return {span:Number(bar.dataset.end)-Number(bar.dataset.start),aligned:bar.dataset.start===graph.dataset.start&&bar.dataset.end===graph.dataset.end,
      height:graph.getBoundingClientRect().height,count:document.querySelectorAll('#zoneBar').length};
   });
   const passed=check.span===360&&check.aligned&&check.height===originalHeight&&check.count===1;
   interactions.push({check:`${width}px graph tap reuses the existing strip without adding height`,passed});
   if(!passed)throw new Error(JSON.stringify(check));
   await page.screenshot({path:path.join(out,`phone-follow-${width}.png`)});
   await page.locator('#rideGraphView').focus();await page.keyboard.press('Enter');
   await page.waitForFunction(()=>document.getElementById('zoneBar').dataset.view==='full');
  }
  fs.writeFileSync(path.join(out,process.argv.includes('--phone-only')?'phone-follow-audit.json':'audit.json'),JSON.stringify({results,errors,interactions},null,2));
  const issueCount=results.reduce((n,r)=>n+r.issues.length,0);
  const overflowCount=results.filter(r=>r.scrollWidth>r.pageWidth+1).length;
  console.log(JSON.stringify({cases:results.length,issues:issueCount,pageOverflowCases:overflowCount,errors}));
  if(issueCount||overflowCount||errors.length)process.exitCode=1;
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
