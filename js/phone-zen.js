/* Presentation only. Ride commands are delegated to the existing phone controls. */
window.PhoneZen = (() => {
  const $ = id => document.getElementById(id);
  const LIGHT = {Z1:['#3d63ff','#19c2e0'],Z2:['#2a86ff','#1fd1b2'],Z3:['#16c08d','#a7e04a'],Z4:['#ffb21f','#ff7a2f'],Z5:['#ff5a36','#ff2d7a'],Z6:['#ff2e63','#a23bff'],Z7:['#9b4dff','#ff3dce']};
  let active = false, history = [], previous = null, seeded = false;
  function setActive(value) {
    active = value;
    document.body.classList.toggle('zen-active',value);
    $('phoneZen').hidden = !value;
    $('btnZen').setAttribute('aria-pressed',String(value));
    if (value) $('zenExit').focus(); else $('btnZen').focus();
    if (previous) update(...previous);
    window.dispatchEvent(new Event('resize'));
  }
  function init() {
    $('btnZen').addEventListener('click',()=>setActive(true));
    $('zenExit').addEventListener('click',()=>setActive(false));
    document.addEventListener('keydown',e=>{if(active && e.key==='Escape')setActive(false);});
    [['zenDown','btnDown'],['zenToggle','btnToggle'],['zenUp','btnUp'],['zenSkip','btnSkip'],['zenPowerView','btnPowerView']].forEach(([zen,normal])=>$(zen).addEventListener('click',()=>{ $(normal).click(); syncControls(); }));
    window.addEventListener('resize',()=>{if(active&&previous)update(...previous);});
  }
  function spark(id,values,color) {
    const canvas=$(id),w=canvas.clientWidth,h=canvas.clientHeight;
    if(!w||!h)return;
    const dpr=devicePixelRatio||1;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
    const g=canvas.getContext('2d');g.scale(dpr,dpr);
    const good=values.filter(v=>v!=null&&Number.isFinite(v));if(good.length<2)return;
    const lo=Math.min(...good)-2,hi=Math.max(...good)+2;
    g.strokeStyle=color;g.lineWidth=1.6;g.beginPath();let pen=false;
    values.forEach((v,i)=>{if(v==null||!Number.isFinite(v)){pen=false;return;}const x=i/Math.max(1,values.length-1)*w,y=h-3-(v-lo)/(hi-lo)*(h-6);pen?g.lineTo(x,y):g.moveTo(x,y);pen=true;});g.stroke();
  }
  function update(s,power,label) {
    if(!s)return;
    if(!previous||s.title!==previous[0].title||s.elapsed<previous[0].elapsed) {
      history=[];seeded=false;
    }
    if(!seeded&&(s.hist?.recent?.h?.length||s.hist?.h?.length)) {
      history=[];seeded=true;
      const hist=s.hist||{},recent=hist.recent,bin=recent?1:hist.bin||1;
      const h=recent?.h||hist.h||[],c=recent?.c||hist.c||[];
      const n=Math.min(59,h.length*bin);
      const now=Math.floor(Date.now()/1000);
      for(let i=n;i>0;i--)history.push({t:now-i,h:h.at(-Math.ceil(i/bin))??null,c:c.at(-Math.ceil(i/bin))??null});
    }
    previous=[s,power,label];
    const basis=power>0?power:s.target||0,pct=s.ftp>0?basis/s.ftp*100:0;
    const zone=window.VeloMetrics&&s.ftp>0?VeloMetrics.zoneForPct(pct):null;
    // Zone light: Zen follows the displayed power; the normal views follow the step's target zone
    // (as the PC cockpit does), so the colour does not flicker when power hovers at a zone edge.
    const lightKey=active?zone&&zone.short:(s.targetZone&&s.targetZone.short)||(zone&&zone.short);
    const colors=lightKey&&LIGHT[lightKey];
    if(colors){document.body.style.setProperty('--zone-a',colors[0]);document.body.style.setProperty('--zone-b',colors[1]);document.body.dataset.zone=lightKey.toLowerCase();}
    const now=Math.floor(Date.now()/1000),sample={t:now,h:s.hr||null,c:s.cadence||null};
    if(history.at(-1)?.t===now)history[history.length-1]=sample;else history.push(sample);
    history=history.filter(p=>now-p.t<60);
    const running=s.state==='running',finished=s.state==='finished';
    $('zenPower').textContent=power!=null&&(power>0||running)?power:'--';
    $('zenPower').classList.toggle('four-digits',String(power).length>3);
    $('zenPowerLabel').textContent='Power · '+label;
    $('zenPowerView').setAttribute('aria-label','Power view: '+label+'. Tap to change averaging.');
    $('zenTarget').textContent=s.target>0?'target '+s.target+' W'+(s.targetPct!=null?' · '+s.targetPct+'% FTP':''):'No target';
    $('zenZone').textContent=zone?zone.short+' · '+zone.name.toUpperCase():'POWER';
    $('zenState').textContent=running?'RIDING':finished?'FINISHED':s.state==='paused'?'PAUSED':'READY';
    $('zenHr').textContent=s.hr||'--';$('zenCadence').textContent=s.cadence||'--';
    $('zenCadenceTarget').textContent=s.targetCadence?'TARGET '+s.targetCadence:'LAST 60 S';
    const wb=s.wbal;
    $('zenReserve').classList.toggle('unavailable',!wb);
    $('zenWbal').textContent=wb?wb.pct+'%':'--';
    $('zenWbalSub').textContent=wb?wb.kj.toFixed(1)+' kJ left'+(wb.state==='burning'&&wb.tte!=null?' · empty in '+Math.floor(wb.tte/60)+':'+String(Math.floor(wb.tte%60)).padStart(2,'0'):''):'No CP model';
    $('zenLiquid').style.height=wb?Math.max(0,Math.min(100,wb.pct))+'%':'0%';
    const C=2*Math.PI*160,arc=C*.75,max=s.target>0?s.target/.625:Math.max(400,(s.ftp||0)*1.6);
    $('zenArc').style.strokeDasharray=Math.max(0,Math.min(1,(power||0)/max))*arc+' '+C;
    $('zenBand').style.strokeDasharray=s.target>0?(s.target*.1/max*arc)+' '+C:'0 '+C;
    $('zenBand').style.strokeDashoffset=-(s.target*.95/max*arc);
    const theta=(135+Math.max(0,Math.min(1,(s.ftp||0)/max))*270)*Math.PI/180;
    const point=r=>[200+Math.cos(theta)*r,200+Math.sin(theta)*r];const a=point(174),b=point(188),t=point(204);
    $('zenFtpTick').setAttribute('x1',a[0]);$('zenFtpTick').setAttribute('y1',a[1]);$('zenFtpTick').setAttribute('x2',b[0]);$('zenFtpTick').setAttribute('y2',b[1]);
    $('zenFtpText').setAttribute('x',t[0]);$('zenFtpText').setAttribute('y',t[1]);$('zenFtpText').textContent=s.ftp>0?'FTP':'';$('zenFtpTick').style.display=s.ftp>0?'':'none';
    syncControls();
    if(active){const streams=history.length>1?history:null;for(const [id,key,color] of [['zenHrTrace','h','#ff5c86'],['zenCadTrace','c','#3ddc97']]){const hist=s.hist||{};const values=streams?Array.from({length:60},(_,i)=>streams.find(p=>p.t===now-59+i)?.[key]??null):(hist.recent?.[key]||hist[key]||[]).slice(-Math.ceil(60/(hist.recent?.[key]?1:hist.bin||1)));spark(id,values,color);}}
  }
  function syncControls() {
    $('zenState').textContent=$('state').textContent;
    for(const [zen,normal] of [['zenDown','btnDown'],['zenToggle','btnToggle'],['zenUp','btnUp'],['zenSkip','btnSkip']]){$(zen).disabled=$(normal).disabled;}
    const label=$('btnToggle').textContent;
    $('zenToggle').textContent=label==='PAUSE'?'Ⅱ':label==='RESUME'?'▶':label;
    $('zenToggle').setAttribute('aria-label',label==='PAUSE'?'Pause ride':label==='RESUME'?'Resume ride':label==='START'?'Start ride':'Ride finished');
    $('zenToggle').classList.toggle('paused',label!=='PAUSE');
    const armed=$('btnSkip').classList.contains('armed');
    $('zenSkip').textContent=armed?'Confirm':'Skip';
    $('zenSkip').setAttribute('aria-label',armed?'Tap again to skip step':'Skip step');
    if(previous){const s=previous[0],pending=Number($('trTarget').textContent);if(pending>0)$('zenTarget').textContent='target '+pending+' W'+(s.ftp>0?' · '+Math.round(pending/s.ftp*100)+'% FTP':'');}
  }
  return {init,update,syncControls,setActive,get active(){return active;}};
})();
