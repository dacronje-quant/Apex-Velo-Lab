'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../js/velo-metrics.js'), 'utf8') + ';globalThis.VeloMetrics = VeloMetrics;');
const VeloRideImporter = require('../js/velo-importer.js');

const FIT_EPOCH_OFFSET = 631065600;

function fitCrc(bytes, start = 0, end = bytes.length) {
  const T = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
  let crc = 0;
  for (let i = start; i < end; i++) {
    const byte = bytes[i];
    let tmp = T[crc & 0xF];
    crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ T[byte & 0xF];
    tmp = T[crc & 0xF];
    crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ T[(byte >> 4) & 0xF];
  }
  return crc;
}

function buildFitBinary(buildFn) {
  const chunks = [];
  const pushU8 = (v) => chunks.push(v & 0xFF);
  const pushS8 = (v) => chunks.push(v & 0xFF);
  const pushU16 = (v) => { chunks.push(v & 0xFF, (v >> 8) & 0xFF); };
  const pushS16 = (v) => { chunks.push(v & 0xFF, (v >> 8) & 0xFF); };
  const pushU32 = (v) => { chunks.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF); };
  const pushS32 = (v) => { chunks.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF); };

  const defs = {};
  const define = (localId, globalMesg, fields) => {
    defs[localId] = fields;
    pushU8(0x40 | (localId & 0x0F));
    pushU8(0);
    pushU8(0); // little-endian
    pushU16(globalMesg);
    pushU8(fields.length);
    for (const [num, size, type] of fields) {
      pushU8(num); pushU8(size); pushU8(type);
    }
  };
  const write = (localId, vals) => {
    pushU8(localId & 0x0F);
    defs[localId].forEach(([, size, type], i) => {
      const v = vals[i];
      const base = type & 0x1F;
      if (size === 1) base === 1 ? pushS8(v) : pushU8(v);
      else if (size === 2) base === 3 ? pushS16(v) : pushU16(v);
      else if (size === 4) base === 5 ? pushS32(v) : pushU32(v);
    });
  };

  buildFn({ define, write });

  const dataSize = chunks.length;
  const header = [14, 0x20, 2132 & 0xFF, (2132 >> 8) & 0xFF,
    dataSize & 0xFF, (dataSize >> 8) & 0xFF, (dataSize >> 16) & 0xFF, (dataSize >>> 24) & 0xFF,
    0x2E, 0x46, 0x49, 0x54];
  const hCrc = fitCrc(header);
  header.push(hCrc & 0xFF, (hCrc >> 8) & 0xFF);
  const out = new Uint8Array(header.length + dataSize + 2);
  out.set(header, 0);
  out.set(chunks, header.length);
  const fCrc = fitCrc(out, 0, header.length + dataSize);
  out[out.length - 2] = fCrc & 0xFF;
  out[out.length - 1] = (fCrc >> 8) & 0xFF;
  return out.buffer;
}

test('FIT parser extracts GPS, enhanced altitude, negative grade/temp, cycling dynamics, laps, and session extras', () => {
  const t0 = Math.floor(Date.parse('2026-08-15T06:00:00Z') / 1000) - FIT_EPOCH_OFFSET;
  const degToSemi = (deg) => Math.round(deg * (2147483648 / 180));
  const altEnc = (m) => Math.round((m + 500) * 5);

  const buf = buildFitBinary(({ define, write }) => {
    // file_id (0)
    define(0, 0, [[0, 1, 0], [1, 2, 132]]);
    write(0, [4, 1]);

    // record (20): ts, lat, lon, alt(u16), enh_alt(u32), hr, cad, dist, speed, pwr, grade(s16), temp(s8), lr(u8), lte, rte, lps, rps
    define(1, 20, [
      [253, 4, 134], [0, 4, 133], [1, 4, 133], [2, 2, 132], [78, 4, 134],
      [3, 1, 2], [4, 1, 2], [5, 4, 134], [73, 4, 134], [7, 2, 132],
      [9, 2, 131], [13, 1, 1], [30, 1, 2],
      [43, 1, 2], [44, 1, 2], [45, 1, 2], [46, 1, 2]
    ]);
    for (let i = 0; i < 120; i++) {
      const isSecondLap = i >= 60;
      write(1, [
        t0 + i,
        degToSemi(-33.9249 + i * 0.0001),
        degToSemi(18.4241 - i * 0.0001),
        altEnc(100), // lower-res altitude (should be overridden by enhanced_altitude)
        altEnc(120 + i * 0.5),
        isSecondLap ? 162 : 138,
        isSecondLap ? 95 : 85,
        (i + 1) * 8 * 100, // 8 m/s in cm
        8000, // 8 m/s in mm/s -> 28.8 km/h
        isSecondLap ? 280 : 180,
        isSecondLap ? 650 : -250, // +6.5% vs -2.5%
        isSecondLap ? 22 : -3,    // +22C vs -3C
        0x80 | 52, // right = 52 -> left = 48
        150, 154, 42, 44 // 75%, 77%, 21%, 22%
      ]);
    }

    // lap (19): 2 laps (lap 2 has uint16 left_right_balance = bit15 | 5100 => right 51%, left 49%)
    define(2, 19, [
      [253, 4, 134], [2, 4, 134], [7, 4, 134], [8, 4, 134], [9, 4, 134],
      [11, 2, 132], [110, 4, 134], [15, 1, 2], [16, 1, 2], [17, 1, 2],
      [19, 2, 132], [20, 2, 132], [21, 2, 132], [22, 2, 132], [24, 1, 0],
      [34, 2, 132], [42, 2, 132], [50, 1, 1]
    ]);
    write(2, [t0 + 59, t0, 60000, 60000, 48000, 12, 8000, 138, 145, 85, 180, 195, 15, 0, 0, 0x8000 | 5200, 182, -3]);
    write(2, [t0 + 119, t0 + 60, 60000, 60000, 48000, 18, 8000, 162, 170, 95, 280, 305, 45, 0, 1, 0x8000 | 5100, 282, 22]);

    // session (18)
    define(3, 18, [
      [253, 4, 134], [2, 4, 134], [5, 1, 0], [6, 1, 0], [7, 4, 134], [8, 4, 134],
      [22, 2, 132], [23, 2, 132], [24, 1, 2], [45, 2, 132], [57, 1, 1], [58, 1, 1],
      [64, 1, 2], [137, 1, 2]
    ]);
    write(3, [t0 + 119, t0, 2, 0, 120000, 120000, 60, 5, 34, 240, 10, 22, 118, 21]);
  });

  const ride = VeloRideImporter.parseFit(buf, 'Tester', 220);
  assert.equal(ride.fitSport, 2);
  assert.equal(ride.fitSubSport, 0);
  assert.equal(ride.duration, 120);
  assert.equal(ride.elevationGainM, 60);
  assert.equal(ride.elevationLossM, 5);
  assert.equal(ride.avgTempC, 10);
  assert.equal(ride.maxTempC, 22);
  assert.equal(ride.avgLeftTe, 75);
  assert.equal(ride.avgRightTe, 77);
  assert.equal(ride.avgLeftPs, 21);
  assert.equal(ride.avgRightPs, 22);
  assert.deepEqual(ride.fitMeta, { trainingEffect: 3.4, anaerobicTe: 2.1, thresholdPower: 240, minHr: 118 });

  // Sample fields (negative lat, positive lon, enhanced_altitude overrode altitude, negative grade/temp)
  const s0 = ride.samples[0];
  assert.ok(s0.lat < -33.9 && s0.lat > -34.0);
  assert.ok(s0.lon > 18.4 && s0.lon < 18.5);
  assert.equal(s0.alt, 120);
  assert.equal(s0.grade, -2.5);
  assert.equal(s0.temp, -3);
  assert.equal(s0.leftBal, 48);
  assert.equal(s0.leftTe, 75);
  assert.equal(s0.rightTe, 77);
  assert.equal(s0.leftPs, 21);
  assert.equal(s0.rightPs, 22);

  const s60 = ride.samples[60];
  assert.equal(s60.alt, 150);
  assert.equal(s60.grade, 6.5);
  assert.equal(s60.temp, 22);

  // Laps
  assert.equal(ride.laps.length, 2);
  assert.equal(ride.laps[0].lapIdx, 1);
  assert.equal(ride.laps[0].startSec, 0);
  assert.equal(ride.laps[0].durationSec, 60);
  assert.equal(ride.laps[0].avgWatts, 180);
  assert.equal(ride.laps[0].trigger, 'manual');
  assert.equal(ride.laps[0].leftBal, 48);
  assert.equal(ride.laps[0].avgTempC, -3);

  assert.equal(ride.laps[1].lapIdx, 2);
  assert.equal(ride.laps[1].startSec, 60);
  assert.equal(ride.laps[1].avgWatts, 280);
  assert.equal(ride.laps[1].ascentM, 45);
  assert.equal(ride.laps[1].trigger, 'time');
  assert.equal(ride.laps[1].leftBal, 49);
});

test('FIT invalid sentinel values stay omitted instead of injecting zeros or fake values', () => {
  const t0 = Math.floor(Date.parse('2026-08-16T06:00:00Z') / 1000) - FIT_EPOCH_OFFSET;
  const buf = buildFitBinary(({ define, write }) => {
    define(0, 20, [
      [253, 4, 134], [0, 4, 133], [1, 4, 133], [78, 4, 134],
      [9, 2, 131], [13, 1, 1], [7, 2, 132], [43, 1, 2]
    ]);
    for (let i = 0; i < 10; i++) {
      write(0, [t0 + i, 0x7FFFFFFF, 0x7FFFFFFF, 0xFFFFFFFF, 0x7FFF, 0x7F, 200, 0xFF]);
    }
  });
  const ride = VeloRideImporter.parseFit(buf, 'Tester', 200);
  assert.equal(ride.avgWatts, 200);
  assert.equal(ride.laps, undefined);
  assert.equal(ride.elevationGainM, undefined);
  assert.equal(ride.avgTempC, undefined);
  assert.equal(ride.avgLeftTe, undefined);
  const s0 = ride.samples[0];
  assert.equal(s0.lat, undefined);
  assert.equal(s0.lon, undefined);
  assert.equal(s0.alt, undefined);
  assert.equal(s0.grade, undefined);
  assert.equal(s0.temp, undefined);
  assert.equal(s0.leftTe, undefined);
});
