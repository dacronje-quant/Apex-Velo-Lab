// Builds the tiny bulk-import fixtures (synthetic rides, a few hundred bytes each) used by
// tests/bulk-import.test.js and the browser tests. Run `node tests/fixtures/bulk-import/make-fixtures.cjs`
// to rewrite the committed files; the output is deterministic.
const fs = require('node:fs'), path = require('node:path');
const fflate = require('../../../vendor/fflate.min.js');

const FIT_EPOCH = 631065600;

/** A minimal activity FIT: sport message, 1 Hz records, session message. power: null leaves the channel out. */
function fit({ start, seconds = 120, power = 200, hr = 140, cadence = 90, sport = 2, subSport = 0, records = true }) {
  const out = [];
  const u8 = (v) => out.push(v & 0xff);
  const u16 = (v) => { u8(v); u8(v >> 8); };
  const u32 = (v) => { u16(v & 0xffff); u16(v >>> 16); };
  const def = (local, global, fields) => { u8(0x40 | local); u8(0); u8(0); u16(global); u8(fields.length); fields.forEach(([n, s, t]) => { u8(n); u8(s); u8(t); }); };
  def(0, 12, [[0, 1, 0], [1, 1, 0]]);
  u8(0); u8(sport); u8(subSport);
  if (records) {
    const fields = [[253, 4, 0x86], [3, 1, 2], [4, 1, 2], [5, 4, 0x86], [6, 2, 0x84]];
    if (power !== null) fields.push([7, 2, 0x84]);
    def(1, 20, fields);
    const t0 = Math.round(Date.parse(start) / 1000) - FIT_EPOCH;
    for (let i = 0; i < seconds; i++) {
      u8(1); u32(t0 + i); u8(hr); u8(cadence); u32(i * 800); u16(8000);
      if (power !== null) u16(power + (i % 7));
    }
  }
  def(2, 18, [[5, 1, 0], [6, 1, 0]]);
  u8(2); u8(sport); u8(subSport);
  const body = Uint8Array.from(out);
  const head = new Uint8Array(14);
  const dv = new DataView(head.buffer);
  dv.setUint8(0, 14); dv.setUint8(1, 0x20); dv.setUint16(2, 2132, true); dv.setUint32(4, body.length, true);
  head.set([0x2e, 0x46, 0x49, 0x54], 8);
  const file = new Uint8Array(14 + body.length + 2);
  file.set(head); file.set(body, 14);
  return file;
}

const iso = (start, i) => new Date(Date.parse(start) + i * 1000).toISOString().replace('.000Z', 'Z');

function tcx({ start, seconds = 90, power = 180, sport = 'Biking' }) {
  const pts = Array.from({ length: seconds }, (_, i) => `<Trackpoint><Time>${iso(start, i)}</Time><DistanceMeters>${i * 7}</DistanceMeters><HeartRateBpm><Value>135</Value></HeartRateBpm><Cadence>88</Cadence><Extensions><ns3:TPX><ns3:Watts>${power}</ns3:Watts></ns3:TPX></Extensions></Trackpoint>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><TrainingCenterDatabase xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><Activities><Activity Sport="${sport}"><Id>${iso(start, 0)}</Id><Lap StartTime="${iso(start, 0)}"><Track>${pts}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
}

function gpx({ start, seconds = 90, type = 'cycling', name = 'GPX ride', power = null, segments = 1 }) {
  const per = Math.ceil(seconds / segments);
  const segs = Array.from({ length: segments }, (_, s) => '<trkseg>' + Array.from({ length: Math.min(per, seconds - s * per) }, (_, j) => {
    const i = s * per + j;
    return `<trkpt lat="${(52 + i * 0.0001).toFixed(4)}" lon="4.3000"><ele>2</ele><time>${iso(start, i)}</time><extensions>${power !== null ? `<power>${power}</power>` : ''}<gpxtpx:TrackPointExtension><gpxtpx:hr>130</gpxtpx:hr><gpxtpx:cad>80</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>`;
  }).join('') + '</trkseg>').join('');
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="fixture" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk><name>${name}</name><type>${type}</type>${segs}</trk></gpx>`;
}

const enc = (s) => new TextEncoder().encode(s);
const gz = (b) => fflate.gzipSync(b, { mtime: 0 });
const ZIPOPT = { mtime: new Date(Date.UTC(2026, 0, 1)) };
const zip = (entries) => fflate.zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, [v, ZIPOPT]])), ZIPOPT);

/** The rides inside the fixtures, so tests can refer to them. */
const RIDES = {
  stravaFit: { start: '2026-03-02T07:00:00Z', seconds: 120, power: 210 },          // cycling, outdoor, with power
  stravaRun: { start: '2026-03-03T07:00:00Z', seconds: 90, type: 'running', name: 'Easy run' },
  stravaVirtual: { start: '2026-03-04T18:00:00Z', seconds: 120, power: 190, subSport: 58 }, // Zwift: indoor
  stravaTcx: { start: '2026-03-05T07:00:00Z', seconds: 90, power: 170 },
  garminPower: { start: '2026-03-06T07:00:00Z', seconds: 120, power: 230 },
  garminNoPower: { start: '2026-03-06T07:00:30Z', seconds: 118, power: null },   // same ride, other device, no power
};

const CSV = [
  'Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Activity Description,Filename',
  '1001,"Mar 2, 2026, 7:00:00 AM","Morning ride, hills",Ride,120,1.0,"Two climbs.\nLegs ""ok"".",activities/1001.fit.gz',
  '1002,"Mar 3, 2026, 7:00:00 AM",Easy run,Run,90,0.3,,activities/1002.gpx',
  '1003,"Mar 4, 2026, 6:00:00 PM",Zwift - Watopia,Virtual Ride,120,1.0,,activities/1003.fit.gz',
  '1004,"Mar 5, 2026, 7:00:00 AM",Coffee spin,Ride,90,0.6,Short one,activities/1004.tcx.gz',
  ''
].join('\n');

function build() {
  const stravaFit = fit(RIDES.stravaFit);
  const strava = zip({
    'activities.csv': enc(CSV),
    'profile.csv': enc('Athlete ID,Email\n1,rider@example.com\n'),
    'activities/1001.fit.gz': gz(stravaFit),
    'activities/1002.gpx': enc(gpx(RIDES.stravaRun)),
    'activities/1003.fit.gz': gz(fit(RIDES.stravaVirtual)),
    'activities/1004.tcx.gz': gz(enc(tcx(RIDES.stravaTcx))),
    'media/photo.jpg': new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
  });
  const inner = zip({
    'rider_2026-03-02.fit': stravaFit,                      // the same file as Strava's 1001 -> exact duplicate
    'rider_2026-03-06_edge.fit': fit(RIDES.garminPower),
    'rider_2026-03-06_watch.fit': fit(RIDES.garminNoPower),
    'monitoring_2026-03-06.fit': fit({ start: RIDES.garminPower.start, records: false, sport: 0 }),
    'broken.fit': enc('not a fit file at all')
  });
  const garmin = zip({
    'DI_CONNECT/DI-Connect-User/user_profile.json': enc('{"userName":"rider"}'),
    'DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip': inner
  });
  return { 'strava-export.zip': strava, 'garmin-export.zip': garmin, 'ride.gpx': enc(gpx({ start: '2026-03-07T07:00:00Z', seconds: 40, name: 'Lunch loop', power: 160, segments: 2 })) };
}

if (require.main === module) {
  for (const [name, bytes] of Object.entries(build())) fs.writeFileSync(path.join(__dirname, name), bytes);
  console.log('bulk-import fixtures written');
}

module.exports = { fit, tcx, gpx, zip, gz, enc, build, RIDES, CSV };
