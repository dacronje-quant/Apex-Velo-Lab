package com.apexvelo.lab.plugins

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream

class ImportFilesTest {
    @Test
    fun rideFilesByExtension() {
        for (n in listOf("ride.fit", "RIDE.FIT", "a/b/ride.tcx", "track.gpx", "export.zip", "1234.fit.gz", "x.TCX.GZ", "y.gpx.gz")) {
            assertTrue(n, ImportFiles.isRideFile(n))
        }
        for (n in listOf("photo.jpg", "activities.csv", "notes.txt", "export.zip.gz", "archive.gz", "fit", "ride.fit.bak")) {
            assertFalse(n, ImportFiles.isRideFile(n))
        }
        assertTrue(ImportFiles.isWatched("Strava/activities.csv"))
        assertFalse(ImportFiles.isWatched("Strava/other.csv"))
    }

    @Test
    fun sharedFilesNeedARideExtensionOrRideMimeType() {
        assertEquals("ride.fit", ImportFiles.sharedName("ride.fit", "application/octet-stream"))
        assertEquals("1234.fit.gz", ImportFiles.sharedName("1234.fit.gz", "application/gzip"))
        assertNull("octet-stream without a ride extension", ImportFiles.sharedName("blob.bin", "application/octet-stream"))
        assertNull(ImportFiles.sharedName("photo.jpg", "image/jpeg"))
        assertEquals("Morning Ride.fit", ImportFiles.sharedName("Morning Ride", "application/vnd.ant.fit"))
        assertEquals("shared.gpx", ImportFiles.sharedName(null, "application/gpx+xml"))
        assertEquals("export.zip", ImportFiles.sharedName("content/export", "application/zip"))
        assertNull("gzip needs to say what is inside", ImportFiles.sharedName("archive", "application/gzip"))
    }

    @Test
    fun stampMatchesTheJsSideAndChangedFilesAreNew() {
        // src/native-import.js builds the same string; tests/native-import.test.mjs checks the same example.
        assertEquals("Garmin/ride.fit|2048|1760000000000", ImportFiles.stamp("Garmin/ride.fit", 2048, 1760000000000))
        val listing = listOf(Triple("a.fit", 10L, 1L), Triple("b.fit", 20L, 2L), Triple("c.fit", 30L, 3L))
        val seen = setOf("a.fit|10|1", "b.fit|20|1") // b.fit changed since it was imported
        val fresh = ImportFiles.newFiles(listing, seen) { ImportFiles.stamp(it.first, it.second, it.third) }
        assertEquals(listOf("b.fit", "c.fit"), fresh.map { it.first })
    }

    /** A stream that hands out at most 3 bytes per read, like a slow provider. */
    private class Trickle(bytes: ByteArray) : InputStream() {
        private val inner = ByteArrayInputStream(bytes)
        override fun read(): Int = inner.read()
        override fun read(b: ByteArray, off: Int, len: Int): Int = inner.read(b, off, minOf(len, 3))
    }

    @Test
    fun chunksAreFullUntilTheEndOfTheStream() {
        val data = ByteArray(10) { it.toByte() }
        val input = Trickle(data)
        val a = ImportFiles.readChunk(input, 4)
        assertArrayEquals(byteArrayOf(0, 1, 2, 3), a.bytes)
        assertFalse(a.eof)
        val b = ImportFiles.readChunk(input, 4)
        assertArrayEquals(byteArrayOf(4, 5, 6, 7), b.bytes)
        val c = ImportFiles.readChunk(input, 4)
        assertArrayEquals(byteArrayOf(8, 9), c.bytes)
        assertTrue(c.eof)
    }

    @Test
    fun exactEndIsReportedOnTheNextRead() {
        val input = ByteArrayInputStream(ByteArray(4))
        assertFalse(ImportFiles.readChunk(input, 4).eof)
        val last = ImportFiles.readChunk(input, 4)
        assertEquals(0, last.bytes.size)
        assertTrue(last.eof)
    }

    @Test
    fun chunkSizeIsCapped() {
        val big = ImportFiles.readChunk(ByteArrayInputStream(ByteArray(ImportFiles.MAX_CHUNK + 10)), Int.MAX_VALUE)
        assertEquals(ImportFiles.MAX_CHUNK, big.bytes.size)
    }

    @Test
    fun inboxNamesAreOneSafeSegment() {
        assertEquals("_.._etc_passwd", ImportFiles.safeSegment("/../etc/passwd"))
        assertEquals("a_b.fit", ImportFiles.safeSegment("a:b.fit"))
        assertEquals("file", ImportFiles.safeSegment(".."))
        assertEquals("ride.fit", ImportFiles.safeSegment("  ride.fit "))
    }
}
