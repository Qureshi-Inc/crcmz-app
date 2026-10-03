package me.crcmz.app

import android.webkit.CookieManager
import io.livekit.android.room.track.LocalAudioTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import livekit.org.webrtc.AudioTrackSink
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt

/**
 * The Huddle transcript from this phone: the call's mic audio (a sink on LiveKit's local
 * audio track), cut into 6-second chunks at 16 kHz, each sent to /api/huddle/transcribe
 * with the signed-in page's cookies (the endpoint the website uses). Silence is skipped
 * (speech-to-text invents words for it). Each line comes back through [onLine], on the
 * main thread. Same as ios/CRCMZ/Transcriber.swift.
 */
class Transcriber(private val scope: CoroutineScope, private val onLine: (String) -> Unit) : AudioTrackSink {
    private val lock = Any()
    private var samples = ShortArray(0)
    private var count = 0
    private var rate = 16_000
    private var track: LocalAudioTrack? = null
    @Volatile private var running = false

    fun start(t: LocalAudioTrack?) {
        running = true
        track = t
        t?.addSink(this)
    }

    fun stop() {
        running = false
        track?.removeSink(this)
        track = null
        synchronized(lock) { count = 0 }
    }

    /** WebRTC's audio thread: 16-bit PCM, interleaved. Kept as 16 kHz mono. */
    override fun onData(audioData: ByteBuffer, bitsPerSample: Int, sampleRate: Int, numberOfChannels: Int,
                        numberOfFrames: Int, absoluteCaptureTimestampMs: Long) {
        if (!running || bitsPerSample != 16 || numberOfFrames <= 0) return
        val buf = audioData.duplicate().order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        val step = maxOf(1, sampleRate / 16_000)
        val chunk: ShortArray?
        synchronized(lock) {
            rate = sampleRate / step
            val need = rate * CHUNK_S
            if (samples.size != need) { samples = ShortArray(need); count = 0 }
            var f = 0
            while (f < numberOfFrames && count < need) {
                var v = 0
                for (c in 0 until numberOfChannels) v += buf.get(f * numberOfChannels + c).toInt()
                samples[count++] = (v / numberOfChannels).toShort()
                f += step
            }
            chunk = if (count >= need) samples.copyOf().also { count = 0 } else null
        }
        chunk?.let { send(it, rate) }
    }

    private fun send(chunk: ShortArray, rate: Int) {
        var sum = 0.0
        for (v in chunk) { val x = v / 32768.0; sum += x * x }
        if (sqrt(sum / chunk.size) < SILENCE) return
        val wav = wav(chunk, rate)
        scope.launch {
            val text = withContext(Dispatchers.IO) { upload(wav) } ?: return@launch
            if (running) onLine(text)
        }
    }

    private fun upload(wav: ByteArray): String? = runCatching {
        val boundary = "crcmz-" + System.nanoTime()
        val c = URL(ENDPOINT).openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.doOutput = true
        c.connectTimeout = 10_000; c.readTimeout = 40_000
        CookieManager.getInstance().getCookie(ENDPOINT)?.let { c.setRequestProperty("Cookie", it) }
        c.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        c.outputStream.use { o ->
            o.write("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n".toByteArray())
            o.write(wav)
            o.write("\r\n--$boundary--\r\n".toByteArray())
        }
        if (c.responseCode != 200) return null
        val text = JSONObject(c.inputStream.bufferedReader().readText()).optString("text").trim()
        text.takeIf { it.isNotEmpty() }?.take(2000)
    }.getOrNull()

    private fun wav(s: ShortArray, rate: Int): ByteArray {
        val out = ByteArrayOutputStream(44 + s.size * 2)
        val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        h.put("RIFF".toByteArray()).putInt(36 + s.size * 2).put("WAVE".toByteArray())
        h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
        h.put("data".toByteArray()).putInt(s.size * 2)
        out.write(h.array())
        val b = ByteBuffer.allocate(s.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (v in s) b.putShort(v)
        out.write(b.array())
        return out.toByteArray()
    }

    private companion object {
        const val CHUNK_S = 6
        const val SILENCE = 0.006
        const val ENDPOINT = "https://app.crcmz.me/api/huddle/transcribe"
    }
}
