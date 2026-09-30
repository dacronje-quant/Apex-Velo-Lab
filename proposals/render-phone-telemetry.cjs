const {chromium}=require('C:/Users/dacro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const profile=[[300,50],[300,65],[360,95],[180,50],[360,95],[180,50],[360,95],[180,50],[360,95],[420,50]];
const total=profile.reduce((a,p)=>a+p[0],0), elapsed=2010, ftp=185;
const hist={p:[],h:[],c:[],bin:3}; let heart=94;
for(let t=0;t<elapsed;t+=3){let end=0; const step=profile.find(p=>(end+=p[0])>t);const target=ftp*step[1]/100;heart+=(target>150?157:116)-heart>0?0.24:-0.18;hist.p.push(Math.round(target+4*Math.sin(t*.11)+3*Math.sin(t*.39)));hist.h.push(Math.round(heart+Math.sin(t*.07)));hist.c.push(Math.round((target>150?91:84)+2*Math.sin(t*.13)));}
const snapshot={state:'running',title:'4 x 6 min Sweet Spot',ftp,bias:100,target:176,baseTarget:176,targetPct:95,power:178,power5:177,hr:153,hrZone:'Z3 Tempo',cadence:91,targetCadence:90,elapsed,totalDuration:total,progress:elapsed/total,profile,hist,trace:hist.p.slice(-120),step:{index:7,count:10,name:'Sweet spot',duration:360,remaining:30},next:{name:'Recovery',duration:180,watts:93},devices:{trainer:true,pedals:true,hr:true},targetZone:{short:'Z4',color:'#fbbf24'},zone:{color:'#fbbf24'},balanceLeft:49.4};
(async()=>{const browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
page.on('pageerror',e=>console.log('PAGE ERROR:',e.message));
await page.route('http://apex-preview.local/**',async route=>{const url=new URL(route.request().url());if(url.pathname.startsWith('/api/')){await new Promise(r=>setTimeout(r,100));await route.fulfill({json:{snapshot,ageMs:0,seq:1}});return;}const file=path.join(root,url.pathname==='/'?'live.html':url.pathname.slice(1));if(!file.startsWith(root)||!fs.existsSync(file)){await route.abort();return;}await route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'application/javascript':'text/html'});});
snapshot.powerAverages={3:179,5:177,7:175,10:174};
await page.goto('http://apex-preview.local/');await page.waitForFunction(()=>document.getElementById('trPower').textContent==='178');
const assert=require('node:assert/strict');
for(const [label,value,diff] of [['3S','179','+3 W'],['5S','177','+1 W'],['7S','175','-1 W'],['10S','174','-2 W'],['CURRENT','178','+2 W']]){
 await page.locator('#btnPowerView').click();
 assert.equal(await page.locator('#trPowerLabel').textContent(),`POWER · ${label}`);
 assert.equal(await page.locator('#trPower').textContent(),value);
 assert.equal(await page.locator('#trPowerSub').textContent(),diff);
}
await page.locator('#btnPowerView').focus();await page.keyboard.press('Enter');
await page.reload();await page.waitForFunction(()=>document.getElementById('trPower').textContent==='179');
assert.equal(await page.locator('#trPowerLabel').textContent(),'POWER · 3S');
for(let i=0;i<4;i++) await page.locator('#btnPowerView').click();
await page.screenshot({path:path.join(__dirname,'telemetry-phone-portrait.png')});
await page.setViewportSize({width:844,height:390});await page.waitForTimeout(300);await page.screenshot({path:path.join(__dirname,'telemetry-phone-landscape.png')});console.log('Passed: five power views, target differences, keyboard activation, persisted selection, portrait and landscape.');await browser.close();})();
