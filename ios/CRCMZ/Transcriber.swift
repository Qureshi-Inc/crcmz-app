import AVFoundation
import LiveKit
import WebKit

/// The Huddle transcript from this phone: LiveKit's mic audio, cut into 6-second chunks,
/// each sent to /api/huddle/transcribe with the signed-in page's cookies (the same
/// endpoint the website uses). Silence is skipped (speech-to-text invents words for it).
/// Each line comes back through `onLine`, and NativeCall shares it with the call.
final class Transcriber: NSObject, AudioRenderer, @unchecked Sendable {
    private static let chunkSeconds = 6.0
    private static let silence: Float = 0.006   // RMS below this is nobody talking
    private static let endpoint = URL(string: "https://app.crcmz.me/api/huddle/transcribe")!

    private let onLine: @MainActor (String) -> Void
    private let queue = DispatchQueue(label: "me.crcmz.transcriber")
    private var samples: [Int16] = []
    private var rate: Double = 48_000
    private var running = false

    init(onLine: @escaping @MainActor (String) -> Void) {
        self.onLine = onLine
    }

    func start() {
        queue.sync { running = true; samples.removeAll(keepingCapacity: true) }
        AudioManager.shared.add(localAudioRenderer: self)
    }

    func stop() {
        AudioManager.shared.remove(localAudioRenderer: self)
        queue.sync { running = false; samples.removeAll() }
    }

    // MARK: AudioRenderer (the audio thread)

    func render(pcmBuffer: AVAudioPCMBuffer) {
        let frames = Int(pcmBuffer.frameLength)
        guard frames > 0 else { return }
        var mono = [Int16](repeating: 0, count: frames)
        if let f = pcmBuffer.floatChannelData {
            let ch = Int(pcmBuffer.format.channelCount)
            for i in 0..<frames {
                var v: Float = 0
                for c in 0..<ch { v += f[c][i] }
                mono[i] = Int16(max(-1, min(1, v / Float(ch))) * Float(Int16.max))
            }
        } else if let s = pcmBuffer.int16ChannelData {
            for i in 0..<frames { mono[i] = s[0][i] }
        } else {
            return
        }
        let sampleRate = pcmBuffer.format.sampleRate
        queue.async { [weak self] in
            guard let self, self.running else { return }
            self.rate = sampleRate
            self.samples.append(contentsOf: mono)
            if Double(self.samples.count) >= self.rate * Self.chunkSeconds {
                let chunk = self.samples
                self.samples.removeAll(keepingCapacity: true)
                self.send(chunk, rate: self.rate)
            }
        }
    }

    // MARK: Upload

    private func send(_ chunk: [Int16], rate: Double) {
        let rms = sqrt(chunk.reduce(Float(0)) { $0 + pow(Float($1) / Float(Int16.max), 2) } / Float(max(chunk.count, 1)))
        guard rms > Self.silence else { return }
        // Speech-to-text wants 16 kHz: drop to it (every 3rd sample at 48 kHz).
        let step = max(1, Int(rate / 16_000))
        let small = step == 1 ? chunk : stride(from: 0, to: chunk.count, by: step).map { chunk[$0] }
        let wav = Self.wav(small, rate: Int(rate) / step)
        Task { @MainActor in
            let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
                .filter { "app.crcmz.me".hasSuffix($0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) }
            var rq = URLRequest(url: Self.endpoint)
            rq.httpMethod = "POST"
            HTTPCookie.requestHeaderFields(with: cookies).forEach { rq.setValue($1, forHTTPHeaderField: $0) }
            let boundary = "crcmz-\(UUID().uuidString)"
            rq.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            var body = Data()
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
            body.append(wav)
            body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
            rq.httpBody = body
            guard let (data, resp) = try? await URLSession.shared.data(for: rq),
                  (resp as? HTTPURLResponse)?.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let text = (json["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty
            else { return }
            self.onLine(String(text.prefix(2000)))
        }
    }

    /// 16-bit mono PCM in a WAV container.
    private static func wav(_ s: [Int16], rate: Int) -> Data {
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        let bytes = UInt32(s.count * 2)
        d.append("RIFF".data(using: .ascii)!); u32(36 + bytes); d.append("WAVE".data(using: .ascii)!)
        d.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
        d.append("data".data(using: .ascii)!); u32(bytes)
        s.withUnsafeBufferPointer { d.append(Data(buffer: $0)) }
        return d
    }
}
