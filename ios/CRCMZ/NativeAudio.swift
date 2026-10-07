import AVFoundation
import MediaPlayer
import UIKit
import WebKit

/// Slap's music, played by the app (frontend/src/lib/nativeAudio.ts, message handler
/// "crcmzAudio"). The page keeps the queue, shuffle, Listen Together and the play counts;
/// the app plays the track, keeps going with the phone locked (it's told the next track
/// and moves on by itself when one ends), and runs the lock screen, Control Center and
/// CarPlay's Now Playing. Events go back to the page through window.__crcmzAudio.
@MainActor
final class NativeAudio: NSObject {
    static let shared = NativeAudio()

    private let player = AVPlayer()
    private weak var web: WKWebView?
    private var url: URL?
    private var nextURL: URL?
    private var together = false
    private var wantsPlay = false   // the page said play before the track was in
    private var info: [String: Any] = [:]
    private var artFor: URL?
    private var timeObserver: Any?
    private var statusObs: NSKeyValueObservation?
    private var controlObs: NSKeyValueObservation?
    private var endObs: NSObjectProtocol?

    func start(web: WKWebView) {
        self.web = web
        player.automaticallyWaitsToMinimizeStalling = true
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        controlObs = player.observe(\.timeControlStatus) { [weak self] p, _ in
            let status = p.timeControlStatus
            Task { @MainActor in self?.controlChanged(status) }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.send("timeupdate") }
        }
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
            let ended = (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.ended.rawValue
            let resume = ((n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0) & AVAudioSession.InterruptionOptions.shouldResume.rawValue != 0
            MainActor.assumeIsolated { if ended && resume { self?.player.play() } }
        }
        remoteCommands()
    }

    // MARK: From the page

    func handle(_ m: [String: Any]) {
        switch m["type"] as? String {
        case "src": if let s = m["url"] as? String, let u = URL(string: s) { load(u) }
        case "stop": stop()
        case "play": wantsPlay = true; activate(); player.play()
        case "pause": wantsPlay = false; player.pause()
        case "seek": if let t = m["time"] as? Double { seek(t, tellPage: false) }
        case "meta": meta(m)
        case "volume": if let v = m["level"] as? Double { player.volume = Float(max(0, min(1, v))) }
        default: break
        }
    }

    private func load(_ u: URL) {
        guard Self.ours(u) else { return }
        // Already playing it: the app moved on to this track by itself before the page caught up.
        if u == url, player.currentItem != nil { resend(); return }
        url = u
        replace(with: u)
    }

    /// `play`: start it as soon as it's in (the stream needs the cookies first, so this is async).
    private func replace(with u: URL, play: Bool = false) {
        url = u
        cookies { [weak self] jar in
            guard let self, self.url == u else { return }
            let asset = AVURLAsset(url: u, options: [AVURLAssetHTTPCookiesKey: jar])
            let item = AVPlayerItem(asset: asset)
            self.statusObs = item.observe(\.status) { [weak self] it, _ in
                let st = it.status
                let d = it.duration.seconds
                Task { @MainActor in self?.itemStatus(st, duration: d) }
            }
            if let e = self.endObs { NotificationCenter.default.removeObserver(e) }
            self.endObs = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.ended() }
            }
            self.player.replaceCurrentItem(with: item)
            if play || self.wantsPlay { self.activate(); self.player.play() }
        }
    }

    private func stop() {
        player.pause()
        player.replaceCurrentItem(with: nil)
        url = nil
        nextURL = nil
        info = [:]
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().playbackState = .stopped
    }

    private func seek(_ t: Double, tellPage: Bool) {
        player.seek(to: CMTime(seconds: max(0, t), preferredTimescale: 600)) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.send("seeked")
                self?.publishTime()
            }
        }
    }

    private func meta(_ m: [String: Any]) {
        together = m["together"] as? Bool ?? false
        nextURL = (m["next"] as? String).flatMap(URL.init(string:)).flatMap { Self.ours($0) ? $0 : nil }
        guard let now = m["now"] as? [String: Any] else { return }
        info[MPMediaItemPropertyTitle] = now["title"] as? String ?? "Slap"
        info[MPMediaItemPropertyArtist] = now["artist"] as? String ?? ""
        info[MPMediaItemPropertyAlbumTitle] = now["album"] as? String ?? ""
        info[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue
        if let s = now["art"] as? String, let a = URL(string: s), Self.ours(a), a != artFor {
            artFor = a
            info.removeValue(forKey: MPMediaItemPropertyArtwork)
            fetchArt(a)
        }
        publishTime()
    }

    // MARK: Moving on by itself

    private func ended() {
        let finished = url
        #if DEBUG
        NSLog("crcmz-demo: ended \(finished?.lastPathComponent ?? "-"), next \(nextURL?.lastPathComponent ?? "none")")
        #endif
        if let n = nextURL {
            if n == finished { seek(0, tellPage: false); player.play() }
            else { replace(with: n, play: true) }
            send("ended")
            send("advanced", paused: false)
        } else {
            send("ended")
        }
    }

    // MARK: Lock screen, Control Center, CarPlay, headphones

    private func remoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.player.currentItem != nil else { return .noActionableNowPlayingItem }
                self.activate(); self.player.play(); self.remote("play"); return .success
            }
        }
        c.pauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.player.pause(); self?.remote("pause"); return .success }
        }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return .commandFailed }
                if self.player.timeControlStatus == .paused { self.activate(); self.player.play(); self.remote("play") }
                else { self.player.pause(); self.remote("pause") }
                return .success
            }
        }
        c.nextTrackCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return .commandFailed }
                // Solo: go now, even with the page asleep. Together: the room decides.
                if !self.together, let n = self.nextURL, n != self.url { self.replace(with: n, play: true) }
                self.remote("nexttrack")
                return .success
            }
        }
        c.previousTrackCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return .commandFailed }
                if self.player.currentTime().seconds > 3 { self.seek(0, tellPage: false) }
                self.remote("previoustrack")
                return .success
            }
        }
        c.changePlaybackPositionCommand.addTarget { [weak self] e in
            MainActor.assumeIsolated {
                guard let self, let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
                self.seek(e.positionTime, tellPage: true)
                self.remote("seekto", time: e.positionTime)
                return .success
            }
        }
        c.skipForwardCommand.isEnabled = false
        c.skipBackwardCommand.isEnabled = false
    }

    private func publishTime() {
        guard !info.isEmpty else { return }
        let d = player.currentItem?.duration.seconds ?? 0
        if d.isFinite && d > 0 { info[MPMediaItemPropertyPlaybackDuration] = d }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = player.currentTime().seconds
        info[MPNowPlayingInfoPropertyPlaybackRate] = player.timeControlStatus == .playing ? 1.0 : 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        MPNowPlayingInfoCenter.default().playbackState = player.timeControlStatus == .paused ? .paused : .playing
    }

    private func fetchArt(_ u: URL) {
        cookies { [weak self] jar in
            var rq = URLRequest(url: u)
            HTTPCookie.requestHeaderFields(with: jar).forEach { rq.setValue($1, forHTTPHeaderField: $0) }
            URLSession.shared.dataTask(with: rq) { data, _, _ in
                guard let data, let img = UIImage(data: data) else { return }
                Task { @MainActor in
                    guard let self, self.artFor == u else { return }
                    self.info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
                    self.publishTime()
                }
            }.resume()
        }
    }

    // MARK: Player state → page

    private func itemStatus(_ s: AVPlayerItem.Status, duration: Double) {
        switch s {
        case .readyToPlay: send("loadedmetadata", duration: duration); publishTime()
        case .failed: send("error")
        default: break
        }
    }

    private func controlChanged(_ s: AVPlayer.TimeControlStatus) {
        switch s {
        case .playing: send("playing")
        case .waitingToPlayAtSpecifiedRate: send("waiting")
        case .paused: send("pause")
        @unknown default: break
        }
        publishTime()
    }

    private func tick() {
        guard player.timeControlStatus == .playing else { return }
        // The page sleeps in the background; it gets the time again when it's back.
        if UIApplication.shared.applicationState == .active { send("timeupdate") }
    }

    private func resend() {
        let d = player.currentItem?.duration.seconds ?? 0
        if player.currentItem?.status == .readyToPlay { send("loadedmetadata", duration: d) }
        send(player.timeControlStatus == .paused ? "pause" : "playing")
    }

    private func remote(_ action: String, time: Double? = nil) {
        var m: [String: Any] = ["event": "remote", "action": action]
        if let time { m["time"] = time }
        post(m)
    }

    private func send(_ event: String, duration: Double? = nil, paused: Bool? = nil) {
        var m: [String: Any] = ["event": event, "time": player.currentTime().seconds.isFinite ? player.currentTime().seconds : 0]
        let d = duration ?? player.currentItem?.duration.seconds ?? 0
        if d.isFinite && d > 0 { m["duration"] = d }
        if let paused { m["paused"] = paused }
        post(m)
    }

    private func post(_ m: [String: Any]) {
        guard let web, let data = try? JSONSerialization.data(withJSONObject: m), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.__crcmzAudio && window.__crcmzAudio(\(json))")
    }

    // MARK: Helpers

    private func activate() {
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    /// The stream and art need the signed-in page's session cookie.
    private func cookies(_ done: @escaping @MainActor ([HTTPCookie]) -> Void) {
        guard let web else { return done([]) }
        web.configuration.websiteDataStore.httpCookieStore.getAllCookies { all in
            let jar = all.filter { "app.crcmz.me".hasSuffix($0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) }
            Task { @MainActor in done(jar) }
        }
    }

    private static func ours(_ u: URL) -> Bool {
        #if DEBUG
        if u.isFileURL { return true }   // the simulator demo below
        #endif
        return u.scheme == "https" && u.host == "app.crcmz.me"
    }

    #if DEBUG
    /// Simulator check without signing in: -crcmzAudioDemo "/path/a.m4a,/path/b.m4a".
    func demo(_ files: [String]) {
        guard files.count >= 2 else { return }
        handle(["type": "src", "url": URL(fileURLWithPath: files[0]).absoluteString])
        handle(["type": "meta", "now": ["title": "Demo one", "artist": "CRCMZ", "album": "Slap"], "next": URL(fileURLWithPath: files[1]).absoluteString])
        handle(["type": "play"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            let i = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
            NSLog("crcmz-demo: now=\(self?.url?.lastPathComponent ?? "-") rate=\(self?.player.rate ?? -1) title=\(i[MPMediaItemPropertyTitle] ?? "-") elapsed=\(i[MPNowPlayingInfoPropertyElapsedPlaybackTime] ?? "-")")
        }
    }
    #endif
}
