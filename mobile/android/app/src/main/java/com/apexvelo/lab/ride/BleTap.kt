package com.apexvelo.lab.ride

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.SystemClock
import java.util.UUID

/**
 * The native recorder's own GATT clients on the devices the page connected (trainer, power meter, strap).
 *
 * Android lets an app open a second GATT client on a device it is already connected to: it shares the same
 * Bluetooth link, so this needs no scan and does not disturb the @capacitor-community/bluetooth-le connection
 * the page uses. Notifications on the link reach every client that registered for them, so [readings] stay
 * current while the WebView is paused, and the FTMS control point can be written from here. If a device drops,
 * the client reconnects by itself when it is back (autoConnect), which needs no background scan either.
 * All callbacks are handled on [handler] (the ride thread).
 */
@SuppressLint("MissingPermission") // started only with BLUETOOTH_CONNECT granted (ApexRidePlugin checks)
class BleTap(private val ctx: Context, private val handler: Handler, private val readings: Readings) {
    private val links = HashMap<String, Link>()

    /** Opens, keeps or closes the clients so they match the page's devices (role -> address, "" for none). */
    fun update(devices: Map<String, String>) {
        for ((role, link) in links.toMap()) if (devices[role] != link.address) { link.close(); links.remove(role) }
        for ((role, address) in devices) {
            if (address.isEmpty() || links.containsKey(role)) continue
            val link = Link(role, address)
            links[role] = link
            link.open()
        }
    }

    /** Writes to the trainer's FTMS control point; false when it cannot be queued. */
    fun writeControl(bytes: ByteArray): Boolean = links["trainer"]?.writeControl(bytes) ?: false

    /** Turns notifications on again (after the page's client let go of them). */
    fun refresh() { for (l in links.values) l.subscribe() }

    fun close() { for (l in links.values) l.close(); links.clear() }

    private inner class Link(val role: String, val address: String) : BluetoothGattCallback() {
        private var gatt: BluetoothGatt? = null
        private var ready = false
        private var closed = false
        private var busy = false
        private val ops = ArrayDeque<(BluetoothGatt) -> Boolean>()
        private val crank = CrankCadence()

        fun open() {
            val adapter = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter ?: return
            val device = try { adapter.getRemoteDevice(address) } catch (e: IllegalArgumentException) { return }
            gatt = device.connectGatt(ctx, false, this, BluetoothDevice.TRANSPORT_LE)
        }

        fun close() {
            closed = true
            try { gatt?.disconnect(); gatt?.close() } catch (e: Exception) { /* already gone */ }
            gatt = null
        }

        private fun chars(): List<Pair<UUID, UUID>> = when (role) {
            "trainer" -> listOf(BleParse.FTMS to BleParse.FTMS_BIKE_DATA)
            "pedals" -> listOf(BleParse.CPS to BleParse.CPS_MEASUREMENT)
            else -> listOf(BleParse.HRS to BleParse.HRS_MEASUREMENT)
        }

        fun subscribe() {
            val g = gatt ?: return
            if (!ready) return
            for ((s, c) in chars()) {
                val ch = g.getService(s)?.getCharacteristic(c) ?: continue
                g.setCharacteristicNotification(ch, true)
                val cccd = ch.getDescriptor(BleParse.CCCD) ?: continue
                enqueue { gg -> writeDescriptor(gg, cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) }
            }
        }

        fun writeControl(bytes: ByteArray): Boolean {
            val ch = gatt?.getService(BleParse.FTMS)?.getCharacteristic(BleParse.FTMS_CONTROL) ?: return false
            enqueue { gg -> writeCharacteristic(gg, ch, bytes) }
            return true
        }

        @Suppress("DEPRECATION")
        private fun writeDescriptor(g: BluetoothGatt, d: BluetoothGattDescriptor, v: ByteArray): Boolean {
            if (Build.VERSION.SDK_INT >= 33) return g.writeDescriptor(d, v) == android.bluetooth.BluetoothStatusCodes.SUCCESS
            d.value = v
            return g.writeDescriptor(d)
        }

        @Suppress("DEPRECATION")
        private fun writeCharacteristic(g: BluetoothGatt, c: BluetoothGattCharacteristic, bytes: ByteArray): Boolean {
            val type = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            if (Build.VERSION.SDK_INT >= 33) return g.writeCharacteristic(c, bytes, type) == android.bluetooth.BluetoothStatusCodes.SUCCESS
            c.writeType = type
            c.value = bytes
            return g.writeCharacteristic(c)
        }

        // One GATT operation at a time per client; the next starts when the last one is answered.
        private fun enqueue(op: (BluetoothGatt) -> Boolean) { ops.addLast(op); next() }

        private fun next() {
            val g = gatt ?: return
            while (!busy && ops.isNotEmpty()) {
                val op = ops.removeFirst()
                busy = try { op(g) } catch (e: Exception) { false }
            }
        }

        private fun done() = handler.post { busy = false; next() }

        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            handler.post {
                if (closed) return@post
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    g.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    ready = false; busy = false; ops.clear()
                    // Comes back by itself when the device is in range again (autoConnect, no scan).
                    handler.postDelayed({ if (!closed) try { g.connect() } catch (e: Exception) { /* retried by the page */ } }, 2000)
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            handler.post { if (!closed) { ready = true; subscribe() } }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) { done() }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) { done() }

        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
            val copy = value.copyOf()
            handler.post { handle(c.uuid, copy) }
        }

        @Deprecated("Android 12 and older")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT >= 33) return // the overload above gets it
            val copy = c.value?.copyOf() ?: return
            handler.post { handle(c.uuid, copy) }
        }

        private fun handle(uuid: UUID, b: ByteArray) {
            val now = SystemClock.elapsedRealtime()
            when (uuid) {
                BleParse.FTMS_BIKE_DATA -> {
                    val d = BleParse.indoorBikeData(b)
                    d.watts?.let { readings.trainerWatts = it }
                    d.cadence?.let { readings.trainerCadence = it }
                    d.speedKmh?.let { readings.speedKmh = it }
                    d.distanceM?.let { readings.distanceM = it }
                    readings.trainerAt = now
                }
                BleParse.CPS_MEASUREMENT -> {
                    val d = BleParse.cpsMeasurement(b) ?: return
                    readings.pedalWatts = d.watts
                    d.leftPct?.let { readings.leftPct = it }
                    if (d.crankRevs != null && d.crankTime != null) crank.update(d.crankRevs, d.crankTime, now)?.let { readings.pedalCadence = it }
                    readings.pedalAt = now
                }
                BleParse.HRS_MEASUREMENT -> {
                    BleParse.heartRate(b)?.let { readings.hr = it }
                    readings.hrAt = now
                }
            }
        }
    }
}
