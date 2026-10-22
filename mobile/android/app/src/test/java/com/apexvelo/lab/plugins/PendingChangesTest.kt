package com.apexvelo.lab.plugins

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class PendingChangesTest {
    private fun file() = File(Files.createTempDirectory("hc").toFile(), "pending.json")
    private fun change(id: String) = JSONObject().put("op", "upsert").put("id", id)
    private fun ids(p: PendingChanges) = p.read().getJSONArray("changes").let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("id") } }

    @Test
    fun appendsWithRisingSeqAndAcksUpToOne() {
        val p = PendingChanges(file())
        p.append(listOf(change("a"), change("b")))
        p.append(listOf(change("c")))
        val seqs = p.read().getJSONArray("changes").let { a -> (0 until a.length()).map { a.getJSONObject(it).getLong("seq") } }
        assertEquals(listOf(1L, 2L, 3L), seqs)
        p.ack(2)
        assertEquals(listOf("c"), ids(p))
        p.append(listOf(change("d")))
        assertEquals(4L, p.read().getJSONArray("changes").getJSONObject(1).getLong("seq"))
    }

    @Test
    fun survivesANewInstanceAndClearKeepsNumbering() {
        val f = file()
        PendingChanges(f).append(listOf(change("a")))
        val p = PendingChanges(f)
        assertEquals(listOf("a"), ids(p))
        p.clear()
        assertEquals(emptyList<String>(), ids(p))
        p.append(listOf(change("b")))
        assertEquals(2L, p.read().getJSONArray("changes").getJSONObject(0).getLong("seq"))
    }

    @Test
    fun overflowAndUnreadableFilesAskForABackfill() {
        val p = PendingChanges(file(), max = 2)
        p.append(listOf(change("a"), change("b"), change("c")))
        assertEquals(listOf("a", "b"), ids(p))
        assertTrue(p.read().getBoolean("overflow"))
        p.clear()
        assertFalse(p.read().getBoolean("overflow"))
        val f = file()
        f.writeText("{not json")
        assertTrue(PendingChanges(f).read().getBoolean("overflow"))
    }
}
