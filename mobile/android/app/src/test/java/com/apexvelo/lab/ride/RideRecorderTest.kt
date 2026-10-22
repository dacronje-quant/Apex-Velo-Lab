package com.apexvelo.lab.ride

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class RideRecorderTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }
    private val plan = RidePlan(listOf(PlanStep("Warmup", 10, 50.0, 100, false), PlanStep("Steady", 10, 75.0, 150, false)), ftp = 200)

    private fun trainer(r: Readings, now: Long) { r.trainerWatts = 200; r.trainerCadence = 90; r.speedKmh = 32.0; r.trainerAt = now }

    @Test
    fun parsersMatchTheWebBluetoothCode() {
        // The browser test's trainer packet: speed 32 km/h, cadence 90, power 200 W.
        val bike = BleParse.indoorBikeData(bytes(0x44, 0x00, 0x80, 0x0c, 180, 0, 200, 0))
        assertEquals(200, bike.watts); assertEquals(90, bike.cadence); assertEquals(32.0, bike.speedKmh!!, 0.001); assertNull(bike.distanceM)
        val withDist = BleParse.indoorBikeData(bytes(0x54, 0x00, 0x80, 0x0c, 180, 0, 0x10, 0x27, 0x00, 250, 0))
        assertEquals(10000, withDist.distanceM); assertEquals(250, withDist.watts)
        // CPS with balance (left reference, 52 %) and crank data.
        val cps = BleParse.cpsMeasurement(bytes(0x23, 0x00, 0xfa, 0x00, 104, 10, 0, 0x00, 0x04))!!
        assertEquals(250, cps.watts); assertEquals(52.0, cps.leftPct!!, 0.001); assertEquals(10, cps.crankRevs); assertEquals(1024, cps.crankTime)
        assertEquals(142, BleParse.heartRate(bytes(0x00, 142)))
        assertEquals(180, BleParse.heartRate(bytes(0x01, 180, 0x00)))
        assertNull("out of range, as on the page", BleParse.heartRate(bytes(0x01, 0x2c, 0x01)))
        assertNull("no skin contact", BleParse.heartRate(bytes(0x04, 142)))
        assertArrayEquals(bytes(0x05, 0x2c, 0x01), BleParse.setTargetPower(300))
        val cad = CrankCadence()
        assertNull(cad.update(10, 0, 0))
        assertEquals(90, cad.update(13, 2048, 1000)) // 3 revs in 2 s
        assertEquals(90, cad.update(13, 2048, 2000)) // between events: held
        assertEquals(0, cad.update(13, 2048, 5000))  // nothing for 3 s: stopped
    }

    @Test
    fun takesOverWhenThePageStopsAndHandsTheSecondsBack() {
        val rec = RideRecorder(3000)
        val r = Readings()
        var now = 0L
        rec.start(plan, 0, 0, 10, 0.0, 0.0, 0.0, now)
        for (t in 1..5) { now += 1000; assertTrue(rec.jsSample(t, 0, 10 - t, t * 8.0, 32.0, 180, 140, 0.0, now)); assertNull(rec.tick(now, now, r).sample) }
        assertEquals(5, rec.elapsed)
        val cmds = ArrayList<Command>()
        val samples = ArrayList<String>()
        for (i in 1..9) {
            now += 1000; trainer(r, now); r.hr = 150; r.hrAt = now
            val res = rec.tick(now, 1_700_000_000_000 + now, r)
            res.sample?.let { samples += it }; cmds += res.commands
        }
        assertTrue(rec.nativeOwns)
        assertEquals(7, samples.size) // the lease ran out on the 3rd silent second
        assertTrue(samples[0].startsWith("{\"time\":6,"))
        assertTrue(samples[0].contains("\"power\":200,\"cadence\":90,\"hr\":150,\"speed\":32.0"))
        assertTrue(samples[0].contains("\"src\":\"TRAINER\""))
        assertEquals(listOf(Command.RequestControl, Command.Target(100), Command.Target(150)), cmds)
        assertFalse("the page cannot record over native seconds", rec.jsSample(13, 1, 7, 0.0, 0.0, 0, 0, 0.0, now))

        val snap = rec.handBack(now)!!
        assertEquals(7, snap.samples.size); assertEquals(12, snap.elapsed); assertEquals(1, snap.step); assertEquals(8, snap.remaining)
        assertEquals(40.0 + 7 * 32 / 3.6, snap.distanceM, 0.01)
        assertTrue(rec.jsSample(13, 1, 7, 140.0, 32.0, 180, 140, 0.0, now + 500))
        assertEquals(0, rec.handBack(now)!!.samples.size)
    }

    @Test
    fun trimPausesFreshnessAndTheEnd() {
        val rec = RideRecorder(3000)
        val r = Readings()
        rec.start(plan.copy(powerMax = 1200), 0, 0, 2, 0.0, 0.0, 0.10, 0)
        assertEquals(110, rec.target()) // PowerMatch trim carried as a share of the target
        var now = 3000L
        val first = rec.tick(now, now, r)
        assertTrue("no fresh device: NONE, zeros", first.sample!!.contains("\"power\":0,\"cadence\":0,\"hr\":0,\"speed\":0.0"))
        assertTrue(first.sample!!.contains("\"src\":\"NONE\""))
        assertEquals(listOf(Command.Pause), rec.setPaused(true, false, now))
        assertNull(rec.tick(now + 1000, now, r).sample)
        assertEquals(listOf(Command.Resume, Command.Target(110)), rec.setPaused(false, false, now))
        now += 1000
        val back = rec.tick(now, now, r)
        assertTrue(back.sample!!.contains("\"segmentStart\":true"))
        assertTrue(back.commands.contains(Command.Target(165)))
        for (i in 0 until 10) { now += 1000; rec.tick(now, now, r) }
        assertTrue(rec.ended)
        assertEquals("{\"type\":\"end\"}", rec.handBack(now)!!.event)
    }

    @Test
    fun rampTestExtendsAndStopsWhenTheTargetIsMissed() {
        val ramp = RidePlan(listOf(PlanStep("Ramp 100% FTP", 3, 100.0, 200, true)), ftp = 200, rampStepPct = 10.0, rampStepSec = 30)
        val rec = RideRecorder(0)
        val r = Readings()
        rec.start(ramp, 0, 0, 3, 0.0, 0.0, 0.0, 0)
        var now = 0L
        for (i in 0 until 3) { now += 1000; trainer(r, now); rec.tick(now, now, r) }
        assertEquals(1, rec.step)
        assertEquals(PlanStep("Ramp 110% FTP", 30, 110.0, 220, true), rec.currentStep())
        assertTrue(rec.stateJson().contains("\"extraSteps\":[{\"name\":\"Ramp 110% FTP\""))
        r.trainerWatts = 100 // far under 85 % of 220 W
        var event: String? = null
        for (i in 0 until 25) { now += 1000; r.trainerAt = now; val res = rec.tick(now, now, r); if (res.commands.contains(Command.Stop)) { event = rec.handBack(now)!!.event; break } }
        assertNotNull(event)
        assertTrue(event!!.contains("target-missed"))
        assertTrue(rec.ended)
    }

    @Test
    fun journalSurvivesACutLineAndIsReadBack() {
        val f = tmp.newFile("active.jsonl")
        val j = RideJournal(f, syncEveryMs = 0)
        j.begin("{\"key\":\"k\"}", listOf("{\"time\":1}"), "{\"step\":0}", 0)
        j.append("{\"time\":2}", "{\"step\":0,\"remaining\":8}", 1000)
        j.close()
        f.appendText("S{\"time\":3,\"pow") // killed mid-write
        val c = RideJournal(f).read()!!
        assertEquals("{\"key\":\"k\"}", c.header)
        assertEquals(listOf("{\"time\":1}", "{\"time\":2}"), c.samples)
        assertEquals("{\"step\":0,\"remaining\":8}", c.state)
        RideJournal(f).delete()
        assertNull(RideJournal(f).read())
    }
}
