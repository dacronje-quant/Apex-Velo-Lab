// Read-only compatibility trial against a user's latest legacy snapshot. All writes go to
// an explicit private trial directory, never to the real SQLite folder or source backups.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const {LocalStore}=require('../scripts/sqlite-store.cjs');
const root=path.resolve(__dirname,'..'),sourceDir=path.join(root,'data','backups');
const files=fs.existsSync(sourceDir)?fs.readdirSync(sourceDir).filter(n=>/^apex_velo_backup_\d{4}-\d{2}-\d{2}_\d{6}\.json\.gz$/.test(n)).sort():[];
if(!files.length){console.log('No legacy snapshots available for an optional read-only compatibility trial.');process.exit(0);}
const source=path.join(sourceDir,files.at(-1)),bytes=fs.readFileSync(source),payload=JSON.parse(zlib.gunzipSync(bytes));
const dir=path.join(root,'.private-review','sqlite-real-data-trial-'+crypto.randomBytes(4).toString('hex'));
const s=new LocalStore({dir,mirrorDir:null}); const settings={};
if(payload.profiles)settings.apex_velo_profiles=JSON.stringify(payload.profiles);
if(payload.activeProfileId)settings.apex_velo_active_prof_id=String(payload.activeProfileId);
if(payload.health)settings.apex_health_v1=JSON.stringify(payload.health);
if(payload.workoutLibrary)settings.apex_velo_saved_workouts=JSON.stringify(payload.workoutLibrary);
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const start=Date.now();
try{
  s.migrate({revision:0,operationId:'real_data_trial_migration',rides:payload.history,settings,dbSettings:[]});
  if(digest(s.rides())!==digest(payload.history))throw new Error('Ride/sample content mismatch');
  const b=s.backup();if(digest(s.readSnapshot(s.snapshotFile(b.name)).payload.history)!==digest(payload.history))throw new Error('Snapshot verification mismatch');
  const count=s.rides().length;s.close();const reopened=new LocalStore({dir,mirrorDir:null});
  try{if(digest(reopened.rides())!==digest(payload.history))throw new Error('Reopened database mismatch');}finally{reopened.close();}
  if(!fs.readFileSync(source).equals(bytes))throw new Error('Source snapshot was modified');
  const report={ok:true,rides:count,samples:payload.history.reduce((n,r)=>n+(r.samples?.length||0),0),elapsedMs:Date.now()-start,originalSnapshotUnchanged:true,fullContentHashMatches:true};
  fs.writeFileSync(path.join(dir,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{try{s.close();}catch{}}
