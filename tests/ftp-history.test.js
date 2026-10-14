const {test}=require('node:test'),assert=require('node:assert/strict');
const H=require('../js/velo-ftp-history.js');
const input=()=>({schema:'apex-ftp-history',version:1,profileId:'p',asOf:'2026-10-11T08:00:00Z',series:{B:[{date:'2026-10-09T10:00:00Z',value:201,low:166,high:236}]}});
test('only training setting and best estimate are main metrics, benchmark is not a displayed metric',()=>{assert.deepEqual(Object.entries(H.METRICS).filter(([,m])=>m.main).map(([k])=>k),['active','B']);assert.equal(H.METRICS.trainerRoad,undefined)});
test('profile-scoped schema refuses another rider',()=>assert.throws(()=>H.normalize(input(),'other'),/different rider/));
test('model gaps remain null, not zero',()=>{const v=input();v.series.B[0].value=null;assert.equal(H.normalize(v,'p').series.B[0].y,null)});
test('invalid watts, future evidence and inverted ranges rejected',()=>{
 for(const mutate of [p=>p.value=Infinity,p=>p.value='201',p=>p.date='2027-01-01',p=>p.low=300,p=>p.high=100]){const v=input();mutate(v.series.B[0]);assert.throws(()=>H.normalize(v,'p'));}
});
test('same-day TrainerRoad ordering preserved without invented update times',()=>{const v=input();v.series.trainerRoad=[{date:'2026-08-12',value:215,order:-3,dateOnly:true},{date:'2026-08-12',value:209,order:-4,dateOnly:true}];assert.deepEqual(H.normalize(v,'p').series.trainerRoad.map(p=>p.y),[209,215])});
test('normalization export round-trip retains values and uncertainty',()=>{const first=H.normalize(input(),'p');assert.deepEqual(H.normalize(H.exportBundle(first),'p'),first)});
test('active history prioritizes actual profile events, no fake earlier setting',()=>{
 const now=Date.parse('2026-10-13');assert.equal(H.activeHistory({ftp:210},[],now).length,1);
 const hist=H.activeHistory({ftp:210,ftpHistory:[{date:'2026-10-09',ftp:210}]},[{date:'2026-10-09',ftpAtRide:215}],now);assert.deepEqual(hist.map(p=>p.y),[210,210]);
});
test('only settings carry into range; model estimates are not extrapolated',()=>{const pts=[{x:1,y:210},{x:3,y:211}];assert.equal(H.inRange(pts,2,4,true)[0].x,2);assert.deepEqual(H.inRange(pts,2,4,false),[{x:3,y:211}]);assert.deepEqual(H.inRange(pts,4,5,false),[])});

test('rows must be objects, not null or arrays',()=>{for(const row of [null,[],'x',7]){const v=input();v.series.B=[row];assert.throws(()=>H.normalize(v,'p'),/Invalid FTP history point/)}});
test('omitted context is kept as null so profile inputs are not compared; supplied context is normalised',()=>{
 assert.equal(H.normalize(input(),'p').context,null);
 const v=input();v.context={maxHr:175,age:35};assert.deepEqual(H.normalize(v,'p').context,{maxHr:175,lthr:null,age:35});
 assert.equal(H.normalize(H.exportBundle(H.normalize(input(),'p')),'p').context,null)});
test('date-only points keep their calendar day west of UTC',t=>{
 const {spawnSync}=require('node:child_process');
 const code=`const H=require('./js/velo-ftp-history.js');const x=Date.parse('2026-08-12');console.log(JSON.stringify({off:new Date(x).getTimezoneOffset(),only:H.formatDate(x,true),local:H.formatDate(x,false)}))`;
 const run=spawnSync(process.execPath,['-e',code],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,TZ:'America/New_York'},encoding:'utf8'});
 const r=JSON.parse(run.stdout);assert.equal(r.only,'12/08/2026');
 if(r.off>0)assert.equal(r.local,'11/08/2026'); else t.diagnostic('TZ override not honoured on this platform; local-day shift not asserted');
});
