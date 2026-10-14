// Real browser + real SQLite server, entirely synthetic and in temporary private folders.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./sqlite-fixture.cjs');
(async()=>{
  const f=await fixture(); const browser=await chromium.launch(require('./browser-options.cjs')); const errors=[];
  const out=path.resolve(__dirname,'../test-output/sqlite');fs.mkdirSync(out,{recursive:true});
  const ready=async page=>{await page.waitForFunction(()=>window.app&&window.VeloStorage?.enabled);await page.evaluate(()=>VeloStorage.flush());};
  const disk=async()=>await(await fetch(f.base+'/api/storage')).json();
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}});context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
    const profile={id:'prof_fixture',name:'Migrated rider',ftp:237,weightKg:73,maxHr:182};
    const ride={id:'legacy_ride',date:'2026-10-01T08:00:00.000Z',title:'Migration fixture',profileName:profile.name,duration:2,tss:1,np:234};
    const full={...ride,samples:[{time:1,power:230,cadence:85,hr:122},{time:2,power:238,cadence:86,hr:124}]};
    const page=await context.newPage();
    // Seed the old browser format before the app's first migration, including IndexedDB-only samples.
    await page.route('**/index.html',r=>r.fulfill({body:'<!doctype html><title>Legacy fixture seed</title>',contentType:'text/html'}));
    await page.goto(f.base+'/index.html');
    await page.evaluate(async({profile,ride,full})=>{
      localStorage.setItem('apex_velo_profiles',JSON.stringify([profile]));localStorage.setItem('apex_velo_active_prof_id',profile.id);
      localStorage.setItem('apex_velo_history',JSON.stringify([ride]));localStorage.setItem('apex_erg_response','responsive');
      localStorage.setItem('apex_health_v1',JSON.stringify({days:{'2026-10-01':{rhr:{'2026-10-01 08:00:00 +0200':52}}}}));
      localStorage.setItem('apex_coach_goal','endurance');
      await new Promise((resolve,reject)=>{const req=indexedDB.open('ApexVeloDB',1);req.onupgradeneeded=()=>{req.result.createObjectStore('rides',{keyPath:'id'});req.result.createObjectStore('settings',{keyPath:'key'});req.result.createObjectStore('profiles',{keyPath:'id'});};req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,tx=db.transaction(['rides','settings'],'readwrite');tx.objectStore('rides').put(full);tx.objectStore('settings').put({key:'legacy_restore_point',createdAt:1,history:[full]});tx.oncomplete=()=>{db.close();resolve();};};});
    },{profile,ride,full});
    await page.unroute('**/index.html');await page.goto(f.base);await ready(page);
    assert.equal(await page.evaluate(()=>app.activeProfile.name),profile.name);assert.deepEqual((await disk()).rides,[full]);assert.equal((await disk()).dbSettings[0].key,'legacy_restore_point');
    assert.equal((await disk()).settings.apex_erg_response,'responsive');assert.equal(JSON.parse((await disk()).settings.apex_health_v1).days['2026-10-01'].rhr['2026-10-01 08:00:00 +0200'],52);
    // All preference changes, including equal-length edits, must reach disk.
    await page.evaluate(async()=>{localStorage.setItem('apex_erg_response','steady');localStorage.setItem('apex_coach_goal','threshold');await VeloStorage.flush();});assert.equal((await disk()).settings.apex_erg_response,'steady');
    await page.evaluate(async()=>{app.completedWorkouts[0].title='Equal length edits are saved';await app.saveHistory();await VeloStorage.flush();});assert.equal((await disk()).rides[0].title,'Equal length edits are saved');
    // The existing Strava undo mechanism must work through SQLite, preserving reference samples.
    await page.evaluate(async()=>{
      const rides=await VeloDB.getAllRides();
      const snapshot={local:{history:localStorage.getItem('apex_velo_history'),block:localStorage.getItem(VeloBlockPlanner.STORAGE_KEY),syncState:localStorage.getItem(VeloStravaSync.STATE_KEY)},idb:rides,memory:structuredClone(app.completedWorkouts)};
      const key=await app.writeStravaBackup(snapshot,{label:'SQLite fixture'});if(!(await VeloDB.getSetting(key)))throw new Error('Missing sync restore point');
      if(!await VeloDB.applyRideChanges([],rides.map(r=>r.id)))throw new Error('Failed test deletion');app.completedWorkouts=[];localStorage.setItem('apex_velo_history','[]');
      await app.restoreSnapshot(snapshot);await VeloStorage.flush();
    });assert.equal((await disk()).rides[0].samples[1].power,238);
    const edited=await disk();
    // A completely new browser context loads the same data without migrating/overwriting it.
    const clean=await browser.newContext();const second=await clean.newPage();second.on('pageerror',e=>errors.push(e.message));await second.goto(f.base);await ready(second);
    assert.equal(await second.evaluate(()=>app.activeProfile.name),profile.name);assert.equal(await second.evaluate(()=>app.completedWorkouts[0].samples[1].power),238);
    // Save a backup using the actual Settings button, preview and restore through the UI.
    await second.evaluate(()=>app.openSettings('backups'));await second.locator('#btnBackupNow').click();await second.waitForFunction(()=>!document.getElementById('btnBackupNow').disabled);
    const backups=await(await fetch(f.base+'/api/storage/backups')).json();const chosen=backups.files.find(b=>b.reason==='manual');assert.ok(chosen);
    await second.evaluate(async()=>{localStorage.setItem('apex_erg_response','responsive');await VeloStorage.flush();});
    await second.locator('#btnListBackups').click();await second.locator(`[data-restore-backup="${chosen.name}"]`).waitFor();
    second.once('dialog',d=>{assert.match(d.message(),/1 rides, 2 samples/);return d.accept();});await second.locator(`[data-restore-backup="${chosen.name}"]`).click();await second.waitForEvent('domcontentloaded');await ready(second);
    assert.equal(await second.evaluate(()=>localStorage.getItem('apex_erg_response')),'steady');
    await second.evaluate(()=>app.openSettings('backups'));await second.waitForTimeout(600);await second.screenshot({path:path.join(out,'backups-desktop.png')});await second.setViewportSize({width:390,height:844});await second.screenshot({path:path.join(out,'backups-mobile.png')});assert.ok(await second.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    // An older tab cannot clobber a save or restore from another tab.
    await page.evaluate(()=>localStorage.setItem('apex_erg_response','smooth'));await page.waitForFunction(()=>VeloStorage.conflict);assert.equal((await disk()).settings.apex_erg_response,'steady');assert.match(await page.locator('#localStorageStatus').textContent(),/Not saved/);
    await page.reload();await ready(page);assert.equal(await page.evaluate(()=>VeloStorage.conflict),false);assert.equal(await page.locator('#unsavedChangeRecovery').isVisible(),true);assert.equal(await page.evaluate(()=>localStorage.getItem('apex_erg_response')),'steady');
    const downloadPromise=page.waitForEvent('download');await page.locator('#btnExportConflictingChanges').click();const recoveryDownload=await downloadPromise;const recovered=JSON.parse(fs.readFileSync(await recoveryDownload.path(),'utf8'));assert.equal(recovered.operations[0].request.settings.apex_erg_response,'smooth');
    await page.evaluate(async()=>{localStorage.setItem('apex_pdc_unit','w');await VeloStorage.flush();});assert.equal((await disk()).settings.apex_pdc_unit,'w');
    await context.close();await clean.close();
    // Browser data clearing is harmless: SQLite restores profiles, samples, health and settings.
    const cleared=await browser.newContext();const third=await cleared.newPage();await third.goto(f.base);await ready(third);assert.equal(await third.evaluate(()=>app.completedWorkouts[0].samples.length),2);assert.equal(await third.evaluate(()=>app.activeProfile.ftp),237);
    // A temporary network failure keeps a recovery outbox and retries safely after reload.
    await third.route('**/api/storage/save',r=>r.abort('failed'));await third.evaluate(()=>{localStorage.setItem('apex_sound_muted','true');localStorage.setItem('apex_zen_cad_halo','0');localStorage.setItem('apex_pdc_unit','wkg');});await third.waitForFunction(()=>VeloStorage.error);assert.equal((await disk()).settings.apex_sound_muted,undefined);
    await third.unroute('**/api/storage/save');await third.reload();await ready(third);assert.equal((await disk()).settings.apex_sound_muted,'true');assert.equal((await disk()).settings.apex_zen_cad_halo,'0');assert.equal((await disk()).settings.apex_pdc_unit,'wkg');assert.equal(await third.evaluate(()=>VeloStorage.pending.length),0);
    // Health exports must remain in the server inbox until SQLite confirms their save.
    const healthStatus=await(await fetch(f.base+'/api/health/status')).json();
    const healthUpload=await fetch(f.base+'/api/health',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+healthStatus.token},body:JSON.stringify({data:{metrics:[{name:'resting_heart_rate',units:'count/min',data:[{date:new Date().toISOString(),qty:55}]}]}})});assert.equal(healthUpload.status,200);
    await third.route('**/api/storage/save',r=>r.abort('failed'));
    const failedHealth=await third.evaluate(()=>app.pullHealthInbox({force:true}));assert.equal(failedHealth.ok,false);assert.equal((await(await fetch(f.base+'/api/health/inbox')).json()).files.length,1);
    await third.unroute('**/api/storage/save');await third.evaluate(()=>VeloStorage.flush());
    const savedHealth=await third.evaluate(()=>app.pullHealthInbox({force:true}));assert.equal(savedHealth.ok,true);assert.equal((await(await fetch(f.base+'/api/health/inbox')).json()).files.length,0);
    assert.equal((await disk()).settings.apex_health_v1,await third.evaluate(()=>localStorage.getItem('apex_health_v1')));
    // An interrupted ride is recovered paused, with original samples, then confirmed on disk.
    await third.evaluate(async()=>{
      app.recordedSamples=[{time:1,power:200,hr:120,cadence:85,segmentStart:true},{time:2,power:210,hr:121,cadence:86}];
      app.totalElapsedSeconds=2;app.sessionStartedAt=Date.now()-2000;app.isWorkoutCompleted=false;await VeloStorage.checkpointRide(app);
    });
    await third.reload();await ready(third);await third.locator('#btnRecoverInterruptedRide').click();assert.equal(await third.evaluate(()=>app.isPlaying),false);assert.equal(await third.evaluate(()=>app.recordedSamples[1].power),210);
    await third.evaluate(async()=>{await app.finishWorkout();await VeloStorage.flush();});assert.equal((await disk()).rides.length,2);assert.equal((await disk()).rides[0].samples[1].power,210);
    // A saved completed ride is never offered as unfinished on the next startup.
    await third.reload();await ready(third);assert.equal(await third.locator('#interruptedRideRecovery').isVisible(),false);
    // Saves send only new or changed rides: an unchanged history posts nothing, one edit posts one ride.
    const posts=[];const watch=r=>{if(r.url().endsWith('/api/storage/save'))posts.push(JSON.parse(r.postData()||'{}'));};third.on('request',watch);
    await third.evaluate(async()=>{await app.saveHistory();await VeloStorage.flush();});assert.equal(posts.length,0);
    await third.evaluate(async()=>{app.completedWorkouts[1].title='Only this ride changed';await app.saveHistory();await VeloStorage.flush();});
    assert.equal(posts.length,1);assert.deepEqual(posts[0].put.map(r=>r.title),['Only this ride changed']);third.off('request',watch);
    // An edit reverted while its save is in flight must persist the latest value, touching only that ride.
    const originalTitle=await third.evaluate(()=>app.completedWorkouts[1].title);
    let releaseEdit;const editGate=new Promise(r=>releaseEdit=r);
    const editRequest=third.waitForRequest(r=>r.url().endsWith('/api/storage/save')&&JSON.parse(r.postData()).put?.some(x=>x.title==='Pending edit'));
    await third.route('**/api/storage/save',async r=>{await editGate;await r.continue();},{times:1});
    posts.length=0;third.on('request',watch);
    await third.evaluate(()=>{app.completedWorkouts[1].title='Pending edit';window.firstEdit=app.saveHistory();});await editRequest;
    await third.evaluate(title=>{app.completedWorkouts[1].title=title;window.undoEdit=app.saveHistory();},originalTitle);
    releaseEdit();await third.evaluate(async()=>{const saved=await Promise.all([window.firstEdit,window.undoEdit]);if(!saved.every(Boolean))throw new Error('Overlapping saves failed');await VeloStorage.flush();});
    assert.equal((await disk()).rides.find(r=>r.id==='legacy_ride').title,originalTitle);
    assert.equal(posts.length,2);assert.ok(posts.every(p=>p.put.length===1),'untouched sample streams are not uploaded');third.off('request',watch);
    // Reverting an in-flight reorder also needs a second write, even when it matches the committed order.
    const originalOrder=await third.evaluate(()=>app.completedWorkouts.map(r=>r.id));
    let releaseOrder;const orderGate=new Promise(r=>releaseOrder=r);
    const orderRequest=third.waitForRequest(r=>r.url().endsWith('/api/storage/save'));
    await third.route('**/api/storage/save',async r=>{await orderGate;await r.continue();},{times:1});
    await third.evaluate(()=>{app.completedWorkouts.reverse();window.firstOrder=app.saveHistory();});await orderRequest;
    await third.evaluate(()=>{app.completedWorkouts.reverse();window.undoOrder=app.saveHistory();});
    releaseOrder();await third.evaluate(async()=>{await Promise.all([window.firstOrder,window.undoOrder]);await VeloStorage.flush();});
    assert.deepEqual((await disk()).rides.map(r=>r.id),originalOrder);
    // The comparison cache follows a successful retry even though the original caller saw a failed save.
    await third.route('**/api/storage/save',r=>r.abort('failed'),{times:1});
    assert.equal(await third.evaluate(async()=>{app.completedWorkouts[1].title='Retry edit';return app.saveHistory();}),false);
    await third.evaluate(()=>VeloStorage.flush());assert.equal((await disk()).rides.find(r=>r.id==='legacy_ride').title,'Retry edit');
    await third.evaluate(async title=>{app.completedWorkouts[1].title=title;await app.saveHistory();await VeloStorage.flush();},originalTitle);
    assert.equal((await disk()).rides.find(r=>r.id==='legacy_ride').title,originalTitle);
    // A save the server refuses (4xx) is reported and dropped; it does not block later saves.
    await third.route('**/api/storage/save',r=>r.fulfill({status:413,contentType:'application/json',body:'{"error":"Request too large"}'}),{times:1});
    await third.evaluate(()=>localStorage.setItem('apex_refused_fixture','x'));await third.waitForFunction(()=>VeloStorage.error);
    assert.equal(await third.evaluate(()=>VeloStorage.conflict),false);
    await third.evaluate(async()=>{localStorage.setItem('apex_after_refusal','ok');await VeloStorage.flush();});assert.equal((await disk()).settings.apex_after_refusal,'ok');
    // A clear reported as failed must not run later from the retry queue.
    await third.route('**/api/storage/save',r=>r.abort('failed'));
    assert.equal(await third.evaluate(()=>VeloDB.clearAllRides()),false);
    await third.unroute('**/api/storage/save');await third.evaluate(async()=>{localStorage.setItem('apex_after_clear','ok');await VeloStorage.flush();});
    assert.equal((await disk()).settings.apex_after_clear,'ok');assert.equal((await disk()).rides.length,2);
    await third.reload();await ready(third);assert.equal((await disk()).rides.length,2);
    // Real ride delete persists; no browser copy resurrects it on restart.
    third.once('dialog',d=>d.accept());await third.evaluate(()=>app.deleteCompletedRide('legacy_ride'));assert.equal((await disk()).rides.length,1);await third.reload();await ready(third);assert.equal(await third.evaluate(()=>app.completedWorkouts.length),1);
    const beforeDemo=await disk();const demo=await cleared.newPage();await demo.goto(f.base+'/?apexDemo=1');await demo.waitForFunction(()=>window.app);assert.equal(await demo.evaluate(()=>VeloStorage.enabled),false);assert.equal(await demo.evaluate(()=>app.completedWorkouts.length),104);assert.deepEqual(await disk(),beforeDemo);
    // Selecting an exported gzip file validates it and asks for a reviewed restore.
    await third.evaluate(()=>app.openSettings('backups'));const uploadReload=third.waitForEvent('domcontentloaded');third.once('dialog',d=>d.accept());
    await third.locator('#localBackupFile').setInputFiles(path.join(f.dir,'saved','backups',chosen.name));await uploadReload;await ready(third);assert.equal((await disk()).rides[0].id,'legacy_ride');assert.equal((await disk()).settings.apex_erg_response,'steady');
    await cleared.close();
    // A browser read failure must stop migration, preserving its original data and an empty PC database.
    const failedFixture=await fixture();const failedContext=await browser.newContext();
    try {
      await failedContext.addInitScript(({profile,full})=>{
        localStorage.setItem('apex_velo_profiles',JSON.stringify([profile]));localStorage.setItem('apex_velo_active_prof_id',profile.id);localStorage.setItem('apex_velo_history',JSON.stringify([full]));
        Object.defineProperty(window,'indexedDB',{configurable:true,value:{open(){throw new Error('deliberately unreadable fixture');}}});
      },{profile,full});
      const failedPage=await failedContext.newPage();failedPage.on('pageerror',e=>errors.push(e.message));await failedPage.goto(failedFixture.base);await failedPage.waitForFunction(()=>window.app);
      assert.equal(await failedPage.evaluate(()=>VeloStorage.enabled),false);assert.match(await failedPage.evaluate(()=>VeloStorage.error),/could not be read/);
      assert.deepEqual(JSON.parse(await failedPage.evaluate(()=>localStorage.getItem('apex_velo_history'))),[full]);
      assert.equal((await(await fetch(failedFixture.base+'/api/storage')).json()).initialized,false);
    }finally{await failedContext.close();await failedFixture.close();}
    assert.deepEqual(errors,[]);
    console.log('Passed: full legacy migration; settings edits; new browser; verified backup/preview/restore and file upload; responsive layout; stale tabs and retained-change export; browser clearing; durable outbox retry; overlapping edit/order reverts and retry cache; interrupted-ride recovery and confirmed completion; deletion persistence; demo isolation; safe migration abort; no page errors.');
  }finally{await browser.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
