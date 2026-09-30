/** Visual QA fixture only. Inject into a temporary copy of index.html?apexTest=1.
 * Never loaded by the production app and never connects to physical Bluetooth devices.
 */
window.addEventListener('load', () => {
  if (!window.__APEX_TEST_MODE__) throw new Error('Device preview requires isolated test mode');
  const a = window.app, ble = a.ble;
  const names = { trainer:'Wahoo KICKR SHIFT', pedals:'Assioma DUO-Shi', hr:'Polar H10', fan:'KICKR HEADWIND' };
  Object.keys(names).forEach(kind => {
    const d = {id:'preview-'+kind,name:names[kind],addEventListener(){},removeEventListener(){},gatt:{connected:true,disconnect(){this.connected=false;}}};
    ble._adopt(kind,d); ble._remember(kind,d);
    Object.assign(ble.slots[kind],{state:'connected',manualDisconnect:false,battery:kind==='pedals'?82:kind==='hr'?65:null,
      chars:{measurement:{},control:{writeValueWithResponse:async bytes => {
        if(kind==='fan' && bytes[0]===2) setTimeout(()=>{ble.slots.fan.fanSpeed=bytes[1];a.renderDevicesPanel();},100);
      }}}});
  });
  ble.slots.trainer.controlGranted = true;
  ble.slots.trainer.capabilities = {trainerControl:true,watts:true,cadence:true,speed:true,distanceMeters:true};
  ble.slots.pedals.capabilities = {watts:true,cadence:true,leftPct:true,calibration:true};
  ble.slots.hr.capabilities = {hr:true};
  ble.slots.fan.capabilities = {fanControl:true};
  ble.slots.fan.fanSpeed = 50;
  a.onHardwareConnected('fan');
  a.bleBattery.pedals=82; a.bleBattery.hr=65;
  const feed=()=>{
    const now=performance.now();
    Object.assign(a.blePedal,{name:names.pedals,watts:185,cadence:91,leftPct:49,rightPct:51,lastTime:now});
    Object.assign(a.bleTrainer,{name:names.trainer,watts:180,cadence:90,speed:31.4,distanceMeters:5300,lastTime:now});
    Object.assign(a.bleHr,{hr:142,contact:true,lastTime:now});
    a.currentSpeed=31.4; a.totalDistanceKm=5.3;
    a.devicePreviewTick(); a.updatePowerSourceBadge();
    // Local test server only, used to exercise the real phone screen with fake readings.
    fetch('api/live',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(a.buildRemoteSnapshot())}).then(r=>r.json()).then(data=>a.takeRemoteCommands(data)).catch(()=>{});
  };
  document.querySelector('#hardwareModal .eyebrow').textContent='Preview · simulated device readings';
  feed(); setInterval(feed,1000); a.openHardwareLab();
});
