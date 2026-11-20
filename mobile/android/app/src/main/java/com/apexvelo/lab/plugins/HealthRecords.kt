package com.apexvelo.lab.plugins

import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.CyclingPedalingCadenceRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.PowerRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.SpeedRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Power
import androidx.health.connect.client.units.Velocity
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneOffset
import kotlin.reflect.KClass

/**
 * The Health Connect record types the app uses, under the names the JS layer (src/native-healthconnect.js)
 * knows them by, and the conversion of records to and from the JSON the plugin passes.
 * Times are epoch milliseconds; zone offsets are seconds (null when the writing app gave none).
 */
object HealthRecords {
    /** Read: recovery data, and cycling sessions from other apps with their series. */
    val READ: Map<String, KClass<out Record>> = linkedMapOf(
        "HeartRateVariabilityRmssd" to HeartRateVariabilityRmssdRecord::class,
        "RestingHeartRate" to RestingHeartRateRecord::class,
        "SleepSession" to SleepSessionRecord::class,
        "Weight" to WeightRecord::class,
        "OxygenSaturation" to OxygenSaturationRecord::class,
        "RespiratoryRate" to RespiratoryRateRecord::class,
        "ExerciseSession" to ExerciseSessionRecord::class,
        "HeartRate" to HeartRateRecord::class,
        "Power" to PowerRecord::class,
        "Speed" to SpeedRecord::class,
        "Cadence" to CyclingPedalingCadenceRecord::class,
        "Distance" to DistanceRecord::class
    )

    /** Write: rides recorded in the app. */
    val WRITE: Map<String, KClass<out Record>> = linkedMapOf(
        "ExerciseSession" to ExerciseSessionRecord::class,
        "HeartRate" to HeartRateRecord::class,
        "Power" to PowerRecord::class,
        "Cadence" to CyclingPedalingCadenceRecord::class,
        "Speed" to SpeedRecord::class,
        "Distance" to DistanceRecord::class,
        "TotalCaloriesBurned" to TotalCaloriesBurnedRecord::class
    )

    /** Types followed with a changes token: the day-level ones. Series (heart rate all day) are read per session. */
    val TRACKED = listOf("HeartRateVariabilityRmssd", "RestingHeartRate", "SleepSession", "Weight", "OxygenSaturation", "RespiratoryRate", "ExerciseSession")

    fun readPermission(type: String): String? = READ[type]?.let { HealthPermission.getReadPermission(it) }
    fun writePermission(type: String): String? = WRITE[type]?.let { HealthPermission.getWritePermission(it) }

    fun nameOf(record: Record): String? =
        READ.entries.firstOrNull { it.value.isInstance(record) }?.key ?: WRITE.entries.firstOrNull { it.value.isInstance(record) }?.key

    private fun offset(o: JSObject, key: String, z: ZoneOffset?) { o.put(key, z?.totalSeconds ?: JSONObject.NULL) }

    private fun pairs(list: List<Pair<Instant, Double>>): JSArray {
        val a = JSArray()
        for ((t, v) in list) a.put(JSArray().put(t.toEpochMilli()).put(v))
        return a
    }

    /** One record as JSON. `withSamples` false leaves series samples out (change notices only need the times). */
    fun toJson(r: Record, withSamples: Boolean = true): JSObject {
        val o = JSObject()
        o.put("type", nameOf(r))
        o.put("id", r.metadata.id)
        o.put("origin", r.metadata.dataOrigin.packageName)
        r.metadata.clientRecordId?.let { o.put("clientId", it) }
        fun instant(t: Instant, z: ZoneOffset?, v: Double) { o.put("time", t.toEpochMilli()); offset(o, "offset", z); o.put("value", v) }
        fun interval(s: Instant, sz: ZoneOffset?, e: Instant, ez: ZoneOffset?) {
            o.put("start", s.toEpochMilli()); offset(o, "startOffset", sz); o.put("end", e.toEpochMilli()); offset(o, "endOffset", ez)
        }
        when (r) {
            is HeartRateVariabilityRmssdRecord -> instant(r.time, r.zoneOffset, r.heartRateVariabilityMillis)
            is RestingHeartRateRecord -> instant(r.time, r.zoneOffset, r.beatsPerMinute.toDouble())
            is WeightRecord -> instant(r.time, r.zoneOffset, r.weight.inKilograms)
            is OxygenSaturationRecord -> instant(r.time, r.zoneOffset, r.percentage.value)
            is RespiratoryRateRecord -> instant(r.time, r.zoneOffset, r.rate)
            is SleepSessionRecord -> {
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset)
                val stages = JSArray()
                for (s in r.stages) stages.put(JSObject().put("start", s.startTime.toEpochMilli()).put("end", s.endTime.toEpochMilli()).put("stage", s.stage))
                o.put("stages", stages)
            }
            is ExerciseSessionRecord -> {
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset)
                o.put("exerciseType", r.exerciseType)
                r.title?.let { o.put("title", it) }
            }
            is HeartRateRecord -> {
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset)
                if (withSamples) o.put("samples", pairs(r.samples.map { it.time to it.beatsPerMinute.toDouble() }))
            }
            is PowerRecord -> {
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset)
                if (withSamples) o.put("samples", pairs(r.samples.map { it.time to it.power.inWatts }))
            }
            is SpeedRecord -> {
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset)
                if (withSamples) o.put("samples", pairs(r.samples.map { it.time to it.speed.inMetersPerSecond }))
            }
            is CyclingPedalingCadenceRecord -> {
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset)
                if (withSamples) o.put("samples", pairs(r.samples.map { it.time to it.revolutionsPerMinute }))
            }
            is DistanceRecord -> { interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset); o.put("value", r.distance.inMeters) }
            is TotalCaloriesBurnedRecord -> { interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset); o.put("value", r.energy.inKilocalories) }
        }
        return o
    }

    /** Series samples per record: Health Connect limits the size of one record, so long rides are split. */
    const val SERIES_CHUNK = 1000

    private fun series(json: JSObject, key: String): List<Pair<Instant, Double>> {
        val a = json.optJSONArray(key) ?: return emptyList()
        val out = ArrayList<Pair<Instant, Double>>(a.length())
        for (i in 0 until a.length()) {
            val p = a.optJSONArray(i) ?: continue
            out.add(Instant.ofEpochMilli(p.getLong(0)) to p.getDouble(1))
        }
        return out
    }

    /**
     * A ride recorded in the app as Health Connect records: the session plus heart rate, power, cadence and
     * speed series, distance and total calories. Every record carries the ride's client id (with a suffix
     * per record), so writing the same ride again replaces the earlier copy instead of adding another.
     */
    fun rideRecords(json: JSObject): List<Record> {
        val clientId = json.getString("clientId") ?: throw IllegalArgumentException("clientId is required")
        val version = json.optLong("version", 1L)
        val start = Instant.ofEpochMilli(json.getLong("start"))
        val end = Instant.ofEpochMilli(json.getLong("end"))
        if (!end.isAfter(start)) throw IllegalArgumentException("The ride ends before it starts.")
        val zone = if (json.has("offset") && !json.isNull("offset")) ZoneOffset.ofTotalSeconds(json.getInt("offset")) else null
        val device = Device(type = Device.TYPE_PHONE)
        fun meta(suffix: String) = Metadata.activelyRecorded(device, "$clientId$suffix", version)
        val out = ArrayList<Record>()
        out.add(ExerciseSessionRecord(start, zone, end, zone, meta(""), json.optInt("exerciseType", ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY), json.optString("title", "").ifBlank { null }))
        fun <S> chunked(key: String, sample: (Instant, Double) -> S?, make: (Instant, Instant, List<S>, Metadata) -> Record) {
            val all = series(json, key).filter { !it.first.isBefore(start) && !it.first.isAfter(end) }
            all.chunked(SERIES_CHUNK).forEachIndexed { i, part ->
                val samples = part.mapNotNull { sample(it.first, it.second) }
                if (samples.isEmpty()) return@forEachIndexed
                // Each record spans its own samples (the last one ends a millisecond after its last sample).
                make(part.first().first, part.last().first.plusMillis(1), samples, meta(":$key:$i")).let { out.add(it) }
            }
        }
        chunked("hr", { t, v -> if (v in 1.0..300.0) HeartRateRecord.Sample(t, v.toLong()) else null }) { s, e, l, m -> HeartRateRecord(s, zone, e, zone, l, m) }
        chunked("power", { t, v -> if (v in 0.0..100000.0) PowerRecord.Sample(t, Power.watts(v)) else null }) { s, e, l, m -> PowerRecord(s, zone, e, zone, l, m) }
        chunked("cadence", { t, v -> if (v in 0.0..10000.0) CyclingPedalingCadenceRecord.Sample(t, v) else null }) { s, e, l, m -> CyclingPedalingCadenceRecord(s, zone, e, zone, l, m) }
        chunked("speed", { t, v -> if (v in 0.0..1000000.0) SpeedRecord.Sample(t, Velocity.metersPerSecond(v)) else null }) { s, e, l, m -> SpeedRecord(s, zone, e, zone, l, m) }
        val meters = json.optDouble("distance", 0.0)
        if (meters > 0) out.add(DistanceRecord(start, zone, end, zone, Length.meters(meters), meta(":distance")))
        val kcal = json.optDouble("kcal", 0.0)
        if (kcal > 0) out.add(TotalCaloriesBurnedRecord(start, zone, end, zone, Energy.kilocalories(kcal), meta(":kcal")))
        return out
    }
}
