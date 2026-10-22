package com.apexvelo.lab.ride

import java.util.UUID

/**
 * Bluetooth SIG parsers and FTMS commands for the native recorder, the same as js/velo-ble.js
 * (parseIndoorBikeData, _parseCpsMeasurement, parseHeartRate, setTargetPower). Plain Kotlin, JVM-tested.
 */
object BleParse {
    private fun uuid16(n: Int): UUID = UUID.fromString(String.format("%08x-0000-1000-8000-00805f9b34fb", n))
    val FTMS: UUID = uuid16(0x1826)
    val FTMS_BIKE_DATA: UUID = uuid16(0x2ad2)
    val FTMS_CONTROL: UUID = uuid16(0x2ad9)
    val CPS: UUID = uuid16(0x1818)
    val CPS_MEASUREMENT: UUID = uuid16(0x2a63)
    val HRS: UUID = uuid16(0x180d)
    val HRS_MEASUREMENT: UUID = uuid16(0x2a37)
    val CCCD: UUID = uuid16(0x2902)

    val REQUEST_CONTROL = byteArrayOf(0x00)
    val START_RESUME = byteArrayOf(0x07)
    val PAUSE = byteArrayOf(0x08, 0x02)
    val STOP = byteArrayOf(0x08, 0x01)

    fun setTargetPower(watts: Int): ByteArray {
        val w = watts.coerceIn(0, 2000)
        return byteArrayOf(0x05, (w and 0xff).toByte(), ((w shr 8) and 0xff).toByte())
    }

    private fun u8(b: ByteArray, o: Int) = b[o].toInt() and 0xff
    private fun u16(b: ByteArray, o: Int) = u8(b, o) or (u8(b, o + 1) shl 8)
    private fun s16(b: ByteArray, o: Int) = u16(b, o).toShort().toInt()

    data class Bike(val watts: Int?, val cadence: Int?, val speedKmh: Double?, val distanceM: Int?)

    /** FTMS Indoor Bike Data (0x2AD2). Absent fields are null. */
    fun indoorBikeData(b: ByteArray): Bike {
        if (b.size < 2) return Bike(null, null, null, null)
        val flags = u16(b, 0)
        var o = 2
        fun has(n: Int) = o + n <= b.size
        var speed: Double? = null; var cadence: Int? = null; var dist: Int? = null; var watts: Int? = null
        if (flags and 0x0001 == 0 && has(2)) { speed = u16(b, o) * 0.01; o += 2 }
        if (flags and 0x0002 != 0) o += 2
        if (flags and 0x0004 != 0 && has(2)) { cadence = Math.round(u16(b, o) * 0.5).toInt(); o += 2 }
        if (flags and 0x0008 != 0) o += 2
        if (flags and 0x0010 != 0 && has(3)) { dist = u8(b, o) or (u8(b, o + 1) shl 8) or (u8(b, o + 2) shl 16); o += 3 }
        if (flags and 0x0020 != 0) o += 2
        if (flags and 0x0040 != 0 && has(2)) { watts = s16(b, o); o += 2 }
        return Bike(watts, cadence, speed, dist)
    }

    data class Cps(val watts: Int, val leftPct: Double?, val crankRevs: Int?, val crankTime: Int?)

    /** Cycling Power Measurement (0x2A63): power, pedal balance and crank revolution data. */
    fun cpsMeasurement(b: ByteArray): Cps? {
        if (b.size < 4) return null
        val flags = u16(b, 0)
        val watts = s16(b, 2)
        var o = 4
        var left: Double? = null
        if (flags and 0x0001 != 0 && o < b.size) {
            val bal = u8(b, o) * 0.5
            val l = if (flags and 0x0002 != 0) bal else 100 - bal
            left = Math.round(l.coerceIn(0.0, 100.0) * 10) / 10.0
            o += 1
        }
        if (flags and 0x0004 != 0) o += 2
        if (flags and 0x0010 != 0) o += 6
        if (flags and 0x0020 != 0 && o + 4 <= b.size) return Cps(watts, left, u16(b, o), u16(b, o + 2))
        return Cps(watts, left, null, null)
    }

    /** Heart Rate Measurement (0x2A37); null without skin contact or for 0/255. */
    fun heartRate(b: ByteArray): Int? {
        if (b.size < 2) return null
        val flags = u8(b, 0)
        val wide = flags and 0x01 != 0
        if (wide && b.size < 3) return null
        val raw = if (wide) u16(b, 1) else u8(b, 1)
        val contact = if (flags and 0x04 != 0) flags and 0x02 != 0 else null
        return if (raw in 1..254 && contact != false) raw else null
    }
}

/** Cadence from CPS crank revolution events, as js/velo-ble.js derives it (holds between events, 0 after 3 s). */
class CrankCadence {
    private var revs: Int? = null
    private var time: Int? = null
    private var last: Int? = null
    private var changedAt = 0L

    fun update(r: Int, t: Int, nowMs: Long): Int? {
        var cadence: Int? = null
        val pr = revs; val pt = time
        if (pr != null && pt != null) {
            val dRevs = (r - pr) and 0xffff
            val dTime = ((t - pt) and 0xffff) / 1024.0
            if (dRevs > 0 && dTime > 0) {
                val c = Math.round(dRevs / dTime * 60).toInt()
                if (c in 15..220) { cadence = c; last = c }
                changedAt = nowMs
            } else if (nowMs - changedAt > 3000) {
                cadence = 0; last = 0
            } else {
                cadence = last
            }
        } else {
            changedAt = nowMs
        }
        revs = r; time = t
        return cadence
    }
}
