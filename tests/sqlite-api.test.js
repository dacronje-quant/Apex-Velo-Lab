const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {fixture}=require('./sqlite-fixture.cjs');
for(const kind of ['node',...(process.platform==='win32'?['powershell','batch']:[])])test(`${kind}: private SQLite API, launcher delegation, migration and restart`,{timeout:60000},async()=>{
  const f=await fixture(kind); let id=0;
  const post=async(url,value)=>fetch(f.base+'/api/storage'+url,{method:'POST',headers:{'Content-Type':'application/json',Origin:f.base},body:JSON.stringify(value)});
  try {
    const state=await(await fetch(f.base+'/api/storage')).json(); assert.equal(state.initialized,false); assert.equal(state.revision,0);
    assert.equal((await fetch(f.base+'/scripts/sqlite-store.cjs')).status,404);
    assert.equal((await fetch(f.base+'/api/storage',{headers:{Origin:'http://evil.example'}})).status,403);
    assert.equal((await fetch(f.base+'/api/storage',{headers:{Origin:'http://localhost:9999'}})).status,403);
    const lan=await new Promise((resolve,reject)=>{const r=http.get(f.base+'/api/storage',{headers:{Host:'192.168.1.5:8080'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);});assert.equal(lan,403);
    assert.equal((await fetch(f.base+'/api/storage',{method:'DELETE'})).status,405);
    const rides=[{id:'from-browser',date:'2026-10-01T08:00:00.000Z',samples:[{time:1,power:321}]}];
    let revision=0; const mutation=extra=>({revision,operationId:'api_test_operation_'+ ++id,...extra});
    let r=await post('/migrate',mutation({rides,settings:{apex_erg_response:'steady'},dbSettings:[]}));assert.equal(r.status,200);revision=(await r.json()).revision;
    assert.equal((await post('/save',{revision:0,operationId:'stale_api_operation',clear:true})).status,409);
    r=await post('/backup',{});assert.equal(r.status,200); const backup=await r.json();
    const preview=await(await post('/preview',{name:backup.name})).json();assert.equal(preview.samples,1);assert.equal(preview.verified,true);
    assert.equal((await post('/preview',{name:'../../.env'})).status,400);
    r=await post('/save',mutation({clear:true}));revision=(await r.json()).revision;
    assert.equal((await post('/restore',mutation({name:backup.name}))).status,200);
    await f.stop(); await f.start(); const reopened=await(await fetch(f.base+'/api/storage')).json();assert.deepEqual(reopened.rides,rides);assert.equal(reopened.settings.apex_erg_response,'steady');
  }finally{await f.close();}
});
