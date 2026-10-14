const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./sqlite-fixture.cjs');
(async()=>{
 const f=await fixture(),browser=await chromium.launch(require('./browser-options.cjs'));
 const out=path.join(__dirname,'../.private-review/ftp-chart-browser');fs.mkdirSync(out,{recursive:true});
 try{
  const state=await(await fetch(f.base+'/api/storage')).json();
  const profile={id:'prof_ftp_fixture',name:'FTP chart fixture',ftp:210,maxHr:175,age:35,weightKg:95};
  const asOf=new Date(Date.now()-86400000).toISOString(),date=new Date(Date.now()-3*86400000).toISOString();
  const bundle={schema:'apex-ftp-history',version:1,profileId:profile.id,asOf,context:{maxHr:175,age:35},series:{
   A:[{date,value:190,low:156,high:224}],Aplus:[{date,value:189,low:162,high:214}],B:[{date,value:201,low:166,high:236,workoutImplied:199,title:'Hard workout'}],
   C:[{date,value:244,low:172,high:326}],Cfloor:[{date,value:198}],trainerRoad:[{date,value:211,reason:'AI FTP Detection'}]}};
  const migration=await fetch(f.base+'/api/storage/migrate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.revision,operationId:'ftp_fixture_migration',rides:[],settings:{apex_velo_profiles:JSON.stringify([profile]),apex_velo_active_prof_id:profile.id},dbSettings:[]})});assert.ok(migration.ok);
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(f.base);
  await page.waitForFunction(()=>window.app&&VeloStorage.enabled&&app.ftpMetricsChart);await page.locator('[data-tab="analytics"]').click();await page.locator('#anaTab-ftp').click();
  await page.waitForFunction(()=>document.getElementById('ftpMetricsStatus').textContent.includes('No saved'));
  const file=path.join(out,'fixture-history.json');fs.writeFileSync(file,JSON.stringify(bundle));await page.locator('#ftpMetricsFile').setInputFiles(file);
  await page.waitForFunction(()=>app._ftpMetricBundle?.series.B.length===1);await page.evaluate(()=>VeloStorage.flush());
  assert.equal(await page.evaluate(()=>app.activeProfile.ftp),210);
  assert.equal(await page.evaluate(()=>app.ftpMetricsChart.data.datasets.some(d=>d.metric==='C')),false);
  const point=await page.evaluate(()=>app.ftpMetricsChart.data.datasets.find(d=>d.metric==='B').data[0]);assert.equal(point.y,201);assert.equal(point.low,166);
  assert.deepEqual(await page.evaluate(()=>app.ftpMetricsChart.data.datasets.map(d=>d.metric)),['active','B','workoutImplied']);
  assert.equal(await page.evaluate(()=>app.ftpMetricsChart.data.datasets.find(d=>d.metric==='workoutImplied').data[0].y),199);
  await page.locator('#ftpMetricsWorkoutDots').uncheck();assert.equal(await page.evaluate(()=>app.ftpMetricsChart.data.datasets.some(d=>d.metric==='workoutImplied')),false);
  await page.locator('#ftpMetricsWorkoutDots').check();
  assert.equal(await page.locator('[data-ftp-metric="trainerRoad"]').count(),0);
  assert.doesNotMatch(await page.locator('#ftpMetricsHistoryCard').innerText(),/TrainerRoad/);
  assert.equal(await page.getByRole('checkbox',{name:'Uncertainty band'}).isChecked(),true);
  await page.locator('#ftpMetricsBand').uncheck();assert.equal(await page.evaluate(()=>app.ftpMetricsChart.options.plugins.ftpBand.enabled),false);
  await page.locator('#ftpMetricsBand').focus();await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>app.ftpMetricsChart.options.plugins.ftpBand.enabled),true);
  assert.equal(await page.locator('#ftpMetricsHistoryCard details').evaluate(d=>d.open),false);
  await page.locator('#ftpMetricsHistoryCard summary').click();await page.waitForFunction(()=>document.querySelectorAll('#ftpMetricsTable tr').length>0);assert.match(await page.locator('#ftpMetricsTable').innerText(),/Bayesian Power Curve/);
  assert.doesNotMatch(await page.locator('#ftpMetricsTable').innerText(),/TrainerRoad/);await page.locator('#ftpMetricsHistoryCard summary').click();
  await page.locator('#ftpMetricsHistoryCard').scrollIntoViewIfNeeded();await page.locator('#ftpMetricsHistoryCard').screenshot({path:path.join(out,'desktop.png')});
  await page.setViewportSize({width:390,height:844});await page.locator('#ftpMetricsHistoryCard').screenshot({path:path.join(out,'mobile.png')});
  assert.equal(await page.evaluate(()=>document.getElementById('ftpMetricsHistoryCard').scrollWidth>document.getElementById('ftpMetricsHistoryCard').clientWidth+1),false);
  await page.evaluate(()=>{app.anaRange='all';app.renderDashboard();});assert.ok(await page.evaluate(()=>app.ftpMetricsChart.data.datasets.find(d=>d.metric==='B').data.length));
  await page.goto(f.base+'/index.html#ftp-metrics');await page.waitForFunction(()=>window.app&&VeloStorage.enabled&&app._ftpMetricBundle&&app.activeTab==='analytics');assert.equal(await page.evaluate(()=>app._ftpMetricBundle.series.B[0].y),201);
  await page.evaluate(()=>{app.activeProfile.lthr=157;app.updateFtpMetricsChart();});assert.match(await page.locator('#ftpMetricsStatus').innerText(),/Profile inputs differ/);await page.evaluate(()=>delete app.activeProfile.lthr);
  await page.evaluate(()=>{app.profiles.push({id:'prof_other',name:'Other fixture',ftp:180});app.setActiveProfile('prof_other',false);});
  await page.waitForFunction(()=>app._ftpMetricProfile==='prof_other');assert.equal(await page.evaluate(()=>app._ftpMetricBundle),null);
  await page.evaluate(()=>app.setActiveProfile('prof_ftp_fixture',false));await page.waitForFunction(()=>app._ftpMetricBundle?.profileId==='prof_ftp_fixture');
  const final=await(await fetch(f.base+'/api/storage')).json();assert.equal(final.rides.length,0);assert.equal(JSON.parse(final.settings.apex_velo_profiles)[0].ftp,210);
  assert.ok(final.dbSettings.some(s=>s.key==='ftp_metric_history:v1:prof_ftp_fixture'));
  assert.deepEqual(errors,[]);console.log('PASS FTP chart: imports, SQLite reload, model/band controls, profile isolation, mobile fit and no FTP/ride changes.');
 }finally{await browser.close();await f.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
