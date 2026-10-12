const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
async function fixture(kind = 'node') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-sqlite-ui-'));
  const appDir = path.join(dir, 'app'); fs.mkdirSync(appDir);
  for (const name of ['index.html','live.html','sw.js','manifest.json','apex-velo-icon.png','apex-velo-icon-192.png','apex-velo-icon.ico','server.js','start_server.ps1','Launch-Apex-Velo.bat','.env.example','js','css','vendor','scripts']) {
    fs.cpSync(path.join(root,name),path.join(appDir,name),{recursive:true});
  }
  fs.mkdirSync(path.join(appDir,'data')); fs.copyFileSync(path.join(root,'data/sample_sweetspot_ride.tcx'),path.join(appDir,'data/sample_sweetspot_ride.tcx'));
  const sock=net.createServer(); await new Promise(r=>sock.listen(0,'127.0.0.1',r)); const port=sock.address().port; await new Promise(r=>sock.close(r));
  fs.writeFileSync(path.join(appDir,'.env'),`APEX_PORT=${port}\nANTHROPIC_API_KEY=\nGEMINI_API_KEY=\nOPENAI_API_KEY=\n`);
  const env={...process.env,APEX_DATA_DIR:path.join(dir,'saved'),APEX_NO_BROWSER:'1',ANTHROPIC_API_KEY:'',GEMINI_API_KEY:'',OPENAI_API_KEY:''};
  const command=kind==='node'?process.execPath:kind==='batch'?'cmd.exe':'powershell.exe';
  const args=kind==='node'?['server.js']:kind==='batch'?['/d','/c','Launch-Apex-Velo.bat']:['-NoProfile','-ExecutionPolicy','Bypass','-File','start_server.ps1'];
  let child, output=''; const base=`http://localhost:${port}`;
  async function start() {
    child=spawn(command,args,{cwd:appDir,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',b=>{output+=b;}); child.stderr.on('data',b=>{output+=b;});
    for(let i=0;i<150;i++) {
      try { const r=await fetch(base+'/api/storage'); if(r.ok)return; }catch{}
      if(child.exitCode!==null)throw new Error(output); await new Promise(r=>setTimeout(r,100));
    } throw new Error('Fixture not ready: '+output);
  }
  async function stop() {
    if(!child || child.exitCode!==null)return;
    // PowerShell delegates to Node; stop its private child tree on Windows.
    if(kind!=='node') await new Promise(r=>spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('exit',r));
    else child.kill();
    if(child.exitCode===null)await new Promise(r=>child.once('exit',r));
  }
  async function close() { await stop(); if(!path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'apex-sqlite-ui-'))throw new Error('Unsafe cleanup');fs.rmSync(dir,{recursive:true,force:true}); }
  await start(); return {dir,appDir,base,start,stop,close,get output(){return output;}};
}
module.exports={fixture};
