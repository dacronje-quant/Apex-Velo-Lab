package com.apexvelo.lab.ride

/**
 * The native ride recorder's logic, without Android (JVM-tested). src/native-ride.js is the page side and
 * tests/fake-ride-native.cjs follows the same contract.
 *
 * The page owns the ride while it ticks: each page second arrives through [jsSample] and renews its lease.
 * When no page second arrives for [leaseMs], [tick] takes the ride over and records 1 Hz samples of the page's
 * shape from the latest Bluetooth [Readings], following the page's [RidePlan] (step targets as the page
 * computes them, PowerMatch trim carried over) and returning the FTMS writes to make. [handBack] gives the
 * native seconds back when the page runs again. All times are monotonic milliseconds.
 */
data class PlanStep(val name: String, val duration: Int, val pctFtp: Double, val watts: Int, val test: Boolean)

data class RidePlan(
    val steps: List<PlanStep>,
    val ftp: Int = 200,
    val bias: Double = 1.0,
    val ergOn: Boolean = true,
    val rampStepPct: Double = 0.0,
    val rampStepSec: Int = 60,
    val weightKg: Double = 75.0,
    val powerMin: Int = 0,
    val powerMax: Int = 2000,
    val powerSource: String = "auto",
    val trainer: String = "",
    val pedals: String = "",
    val hr: String = "",
)

/** Latest values from the native GATT clients; a field is null until its device sends it. */
class Readings {
    @Volatile var pedalWatts: Int? = null
    @Volatile var pedalCadence: Int? = null
    @Volatile var leftPct: Double? = null
    @Volatile var pedalAt = Long.MIN_VALUE / 2
    @Volatile var trainerWatts: Int? = null
    @Volatile var trainerCadence: Int? = null
    @Volatile var speedKmh: Double? = null
    @Volatile var distanceM: Int? = null
    @Volatile var trainerAt = Long.MIN_VALUE / 2
    @Volatile var hr: Int? = null
    @Volatile var hrAt = Long.MIN_VALUE / 2
}

sealed class Command {
    object RequestControl : Command()
    data class Target(val watts: Int) : Command()
    object Pause : Command()
    object Resume : Command()
    object Stop : Command()
}

data class TickResult(val sample: String?, val commands: List<Command>)

data class Snapshot(
    val samples: List<String>, val elapsed: Int, val step: Int, val remaining: Int, val distanceM: Double,
    val maxSpeed: Double, val extraSteps: List<PlanStep>, val paused: Boolean, val event: String?,
)

class RideRecorder(private val leaseMs: Long = 3000) {
    var active = false; private set
    var nativeOwns = false; private set
    var paused = false; private set
    var ended = false; private set
    var elapsed = 0; private set
    var step = 0; private set
    var remaining = 0; private set
    var distanceM = 0.0; private set
    var maxSpeed = 0.0; private set
    var lastPower = 0; private set
    var lastHr = 0; private set
    var plan = RidePlan(emptyList()); private set
    private var trim = 0.0
    private var leaseUntil = 0L
    private var nextSegment = false
    private var lastTargetAt = 0L
    private var odoLast: Int? = null
    private val extraSteps = ArrayList<PlanStep>()
    private val native = ArrayList<String>()
    private var event: String? = null
    private val test = TestMonitor()

    fun start(plan: RidePlan, time: Int, step: Int, remaining: Int, distanceM: Double, maxSpeed: Double, trim: Double, now: Long) {
        this.plan = plan
        active = true; nativeOwns = false; paused = false; ended = false; event = null
        elapsed = time; this.step = step; this.remaining = remaining; this.distanceM = distanceM; this.maxSpeed = maxSpeed
        this.trim = trim
        extraSteps.clear(); native.clear(); odoLast = null
        leaseUntil = now + leaseMs
    }

    fun setPlan(p: RidePlan) { plan = p; extraSteps.clear() }

    /** A page second. False when the native side owns the ride (or it is paused/ended): the page must take it back. */
    fun jsSample(time: Int, step: Int, remaining: Int, distanceM: Double, maxSpeed: Double, power: Int, hr: Int, trim: Double, now: Long): Boolean {
        if (!active || nativeOwns || paused || ended || time <= elapsed) return false
        elapsed = time; this.step = step; this.remaining = remaining; this.distanceM = distanceM; this.maxSpeed = maxSpeed
        lastPower = power; lastHr = hr; this.trim = trim
        leaseUntil = now + leaseMs
        return true
    }

    /** Pause/resume. From the page the page writes to the trainer itself; from the notification the native side does when it owns the ride. */
    fun setPaused(p: Boolean, fromPage: Boolean, now: Long): List<Command> {
        if (!active || p == paused) return emptyList()
        paused = p
        if (!p) { leaseUntil = now + leaseMs; nextSegment = true }
        if (fromPage || !nativeOwns || !plan.ergOn) return emptyList()
        return if (p) listOf(Command.Pause) else listOf(Command.Resume, Command.Target(target()))
    }

    fun steps(): List<PlanStep> = plan.steps + extraSteps
    fun currentStep(): PlanStep? = steps().getOrNull(step)

    /** The trainer target for the current step: the page's step target with the PowerMatch trim, clamped like js/velo-ble.js. */
    fun target(): Int {
        val st = currentStep() ?: return 0
        val trimW = (st.watts * trim).coerceIn(-45.0, 45.0)
        return Math.round(st.watts + trimW).toInt().coerceIn(maxOf(0, plan.powerMin), minOf(2000, plan.powerMax))
    }

    fun tick(now: Long, wallMs: Long, r: Readings): TickResult {
        if (!active || paused || ended) return TickResult(null, emptyList())
        val cmds = ArrayList<Command>()
        if (!nativeOwns) {
            if (now < leaseUntil) return TickResult(null, emptyList())
            nativeOwns = true
            odoLast = null
            if (plan.ergOn) { cmds += Command.RequestControl; cmds += Command.Target(target()); lastTargetAt = now }
        }
        elapsed++
        remaining--
        val st = currentStep() ?: PlanStep("", 1, 0.0, 0, false)

        val pedal = now - r.pedalAt < 3500 && r.pedalWatts != null && plan.powerSource != "trainer"
        val trainer = now - r.trainerAt < 3500 && r.trainerWatts != null && plan.powerSource != "pedals"
        val trainerLink = now - r.trainerAt < 3500
        var power = 0; var src = "NONE"; var left: Double? = null
        if (pedal) { power = maxOf(0, r.pedalWatts ?: 0); src = "PEDALS"; left = r.leftPct }
        else if (trainer) { power = maxOf(0, r.trainerWatts ?: 0); src = "TRAINER" }
        var cadence: Int? = null
        for (k in if (plan.powerSource == "trainer") listOf("trainer") else listOf("pedals", "trainer")) {
            val c = if (k == "pedals") r.pedalCadence.takeIf { now - r.pedalAt < 3500 } else r.trainerCadence.takeIf { trainerLink }
            if (c != null) { cadence = c; break }
        }
        val hr = if (now - r.hrAt < 4000) r.hr ?: 0 else 0
        val speed = r.speedKmh?.takeIf { trainerLink && it >= 0 }?.let { Math.round(it * 10) / 10.0 } ?: virtualSpeedKmh(power, plan.weightKg)
        maxSpeed = maxOf(maxSpeed, speed)
        val odo = r.distanceM?.takeIf { trainerLink }
        if (odo != null) {
            val prev = odoLast
            if (prev != null && odo - prev in 0..500) distanceM += odo - prev
            odoLast = odo
        } else {
            odoLast = null
            distanceM += speed / 3.6
        }
        lastPower = power; lastHr = hr

        val sample = buildString {
            append("{\"time\":").append(elapsed).append(",\"timestamp\":").append(wallMs)
            append(",\"segmentStart\":").append(nextSegment).append(",\"target\":").append(st.watts)
            append(",\"workoutStep\":").append(step).append(",\"stepTime\":").append(maxOf(0, st.duration - remaining))
            append(",\"power\":").append(power).append(",\"cadence\":").append(cadence ?: 0).append(",\"hr\":").append(hr)
            append(",\"speed\":").append(speed).append(",\"dist\":").append(Math.round(distanceM / 10) / 100.0)
            append(",\"leftBal\":").append(left ?: "null").append(",\"rightBal\":").append(left?.let { Math.round((100 - it) * 10) / 10.0 } ?: "null")
            append(",\"src\":\"").append(src).append("\",\"bg\":1}")
        }
        nextSegment = false
        native += sample

        // A ramp test the rider can no longer hold ends here, as VeloErg.testFailure ends it on the page.
        val failure = if (st.test && (src == "PEDALS" || src == "TRAINER")) test.check("$step:${st.watts}", st.watts, power, cadence) else { test.reset(); null }
        if (failure != null) {
            ended = true
            event = failure
            if (plan.ergOn) cmds += Command.Stop
            return TickResult(sample, cmds)
        }

        if (remaining <= 0) {
            val all = steps()
            if (step == all.size - 1 && st.test && plan.rampStepPct > 0) {
                val pct = st.pctFtp + maxOf(0.1, plan.rampStepPct)
                val w = Math.round(plan.ftp * pct / 100 * plan.bias).toInt()
                if (w > 2000) {
                    ended = true
                    event = "{\"type\":\"test-stop\",\"reason\":\"controller-limit\"}"
                    if (plan.ergOn) cmds += Command.Stop
                    return TickResult(sample, cmds)
                }
                extraSteps += PlanStep("Ramp ${fmt(pct)}% FTP", maxOf(1, plan.rampStepSec), pct, w, true)
            }
            if (step + 1 >= steps().size) {
                // The workout is done: an easy load until the rider opens the app, which saves the ride.
                ended = true
                event = "{\"type\":\"end\"}"
                remaining = 0
                if (plan.ergOn) cmds += Command.Target(Math.round(plan.ftp * 0.45 * plan.bias).toInt())
                return TickResult(sample, cmds)
            }
            step++
            remaining = steps()[step].duration
            if (plan.ergOn) { cmds += Command.Target(target()); lastTargetAt = now }
        } else if (plan.ergOn && now - lastTargetAt >= 10_000) {
            cmds += Command.Target(target()) // keep-alive, and a retry after a write the trainer missed
            lastTargetAt = now
        }
        return TickResult(sample, cmds)
    }

    /** The page runs again: the native seconds since it last owned the ride, its new position and what happened. */
    fun handBack(now: Long): Snapshot? {
        if (!active) return null
        val s = Snapshot(ArrayList(native), elapsed, step, remaining, distanceM, maxSpeed, ArrayList(extraSteps), paused, event)
        native.clear()
        event = null
        nativeOwns = false
        leaseUntil = now + leaseMs
        return s
    }

    fun stop() { active = false; nativeOwns = false; native.clear() }

    /** State line for the journal (with extraSteps, so a recovered ramp test keeps its steps). */
    fun stateJson(): String = buildString {
        append("{\"step\":").append(step).append(",\"remaining\":").append(remaining)
        append(",\"distanceM\":").append(Math.round(distanceM * 10) / 10.0).append(",\"maxSpeed\":").append(maxSpeed)
        append(",\"extraSteps\":[")
        extraSteps.forEachIndexed { i, s -> if (i > 0) append(','); append(stepJson(s)) }
        append("]}")
    }

    companion object {
        fun fmt(d: Double): String = if (d == Math.floor(d)) d.toLong().toString() else d.toString()

        fun stepJson(s: PlanStep): String =
            "{\"name\":\"${s.name.replace("\\", "\\\\").replace("\"", "\\\"")}\",\"duration\":${s.duration},\"pctFtp\":${fmt(s.pctFtp)},\"effort\":\"ramp\",\"rampExtension\":true}"

        /** Steady road speed from power, as VeloApp.calcVirtualSpeedKmh. */
        fun virtualSpeedKmh(watts: Int, weightKg: Double, bikeKg: Double = 9.0): Double {
            if (watts <= 0) return 0.0
            val m = weightKg + bikeKg
            val g = 9.81; val crr = 0.004; val cda = 0.32; val rho = 1.225
            var v = 7.0
            for (i in 0 until 12) {
                val f = 0.5 * rho * cda * v * v * v + crr * m * g * v - watts
                val fp = 1.5 * rho * cda * v * v + crr * m * g
                val next = v - f / fp
                if (Math.abs(next - v) < 0.01) { v = next; break }
                v = maxOf(0.1, next)
            }
            return maxOf(0.0, Math.round(v * 3.6 * 10) / 10.0)
        }
    }
}

/** VeloErg.testFailure: after 6 s settling per target, 3 s average power under 85 % for 10 s (3 s with cadence under 60). */
class TestMonitor {
    private var key: String? = null
    private var settle = 0
    private val power = ArrayDeque<Int>()
    private var under = 0
    private var lowCadence = 0

    fun reset() { key = null }

    fun check(k: String, target: Int, p: Int, cadence: Int?): String? {
        if (target <= 0) { reset(); return null }
        if (key != k) { key = k; settle = 6; power.clear(); under = 0; lowCadence = 0 }
        if (settle > 0) { settle--; return null }
        power.addLast(p)
        if (power.size > 3) power.removeFirst()
        if (power.size < 3) return null
        val avg = power.sum() / 3.0
        val isUnder = avg < target * 0.85
        under = if (isUnder) under + 1 else 0
        lowCadence = if (isUnder && cadence != null && cadence < 60) lowCadence + 1 else 0
        if (lowCadence >= 3 || under >= 10) {
            val reason = if (lowCadence >= 3) "cadence-collapse" else "target-missed"
            return "{\"type\":\"test-stop\",\"reason\":\"$reason\",\"measuredWatts\":${Math.round(avg)}}"
        }
        return null
    }
}
