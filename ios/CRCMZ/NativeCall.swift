import AVKit
import LiveKit
import SwiftUI
import UIKit

/// Huddle and the Watch Party's camera call, natively (LiveKit), so they float in picture
/// in picture like a FaceTime call and keep going with the app in the background.
///
/// The page still decides who you are and which room: it fetches the LiveKit token and
/// posts it here (frontend/src/lib/nativeCall.ts, message handler "crcmzCall"):
///
///     start  connect. Huddle: publish camera + mic, full screen. Watch: listen only,
///            the cameras of whoever is on float over the party in a small panel.
///     join   Watch: put your camera on (mic stays muted until you unmute).
///     show   bring the call back up.
///     end    the page left: hang up.
///     data   publish on the call's data channel (Huddle: hands, reactions, lines).
///     transcript  Huddle: record this phone's mic for the transcript (Transcriber).
///
/// Leave here hangs up and tells the page (window.__crcmzCallEnded). What arrives on the
/// data channel goes to the page too (window.__crcmzCallData), so its AI helper reads the
/// whole conversation. Shared screens get their own tile.
@MainActor
final class NativeCall: ObservableObject {
    static let shared = NativeCall()

    enum Kind: String { case huddle, watch }
    enum Mode { case hidden, panel, full }

    struct Tile: Identifiable {
        let id: String
        let name: String
        let track: VideoTrack?
        let speaking: Bool
        let isLocal: Bool
        let micOn: Bool
        var isScreen = false
        var hand = false
    }

    struct Reaction: Identifiable { let id: Int; let name: String; let emoji: String }
    static let topic = "crcmz-huddle"
    static let reactionSet = ["👍", "😂", "🔥", "👏", "❤️", "😮"]

    @Published private(set) var kind: Kind?
    @Published private(set) var title = ""
    @Published private(set) var tiles: [Tile] = []
    @Published private(set) var micOn = false
    @Published private(set) var camOn = false
    @Published private(set) var connecting = false
    @Published var mode: Mode = .hidden { didSet { if mode != oldValue { onMode?(mode) } } }
    @Published private(set) var myHand = false
    @Published private(set) var reactions: [Reaction] = []
    @Published private(set) var transcribing = false
    /// The AI chat (the page keeps it and asks the AI; this shows it on the call screen).
    struct AiMsg: Identifiable { let id: Int; let role: String; let text: String }
    @Published private(set) var aiLog: [AiMsg] = []
    @Published private(set) var aiBusy = false
    @Published var showingAI = false

    var onMode: ((Mode) -> Void)?
    var onTiles: (() -> Void)?
    var onEnded: ((Kind) -> Void)?
    /// To the page: (kind, message, from name, from id). Own transcript lines come as id "me".
    var onData: ((Kind, [String: Any], String, String) -> Void)?
    /// Open a page of the app (the AI helper lives on the Huddle page).
    var onOpenPage: ((String) -> Void)?

    private var hands: [String: String] = [:]   // identity -> name
    private var reactionSeq = 0
    private lazy var transcriber = Transcriber { [weak self] text in self?.ownLine(text) }

    private var room: Room?
    private var events: Events?
    private var startedAt = Date.distantPast
    let pip = CallPip()

    // MARK: From the page

    func handle(_ m: [String: Any]) {
        guard let type = m["type"] as? String, let kind = (m["kind"] as? String).flatMap(Kind.init) else { return }
        switch type {
        case "start":
            guard let url = m["url"] as? String, let token = m["token"] as? String else { return }
            start(kind: kind, url: url, token: token, title: m["title"] as? String ?? "CRCMZ",
                  publish: m["publish"] as? Bool ?? false, camera: m["camera"] as? Bool ?? false,
                  mic: m["mic"] as? Bool ?? false)
        case "join":
            guard self.kind == kind else { return }
            mode = kind == .huddle ? .full : .panel
            if !camOn { toggleCamera() }
        case "show":
            guard self.kind == kind else { return }
            mode = kind == .huddle ? .full : .panel
        case "end":
            guard self.kind == kind else { return }
            hangUp(tellPage: false)
        case "data":
            guard self.kind == kind, let payload = m["payload"] as? [String: Any] else { return }
            publish(payload)
            if payload["t"] as? String == "hand" { myHand = payload["up"] as? Bool ?? false; refresh() }
            if payload["t"] as? String == "rx", let e = payload["e"] as? String { showReaction("You", e) }
        case "transcript":
            guard self.kind == kind else { return }
            setTranscript(m["on"] as? Bool ?? false)
        case "ai":
            let log = m["log"] as? [[String: Any]] ?? []
            aiLog = log.enumerated().map { AiMsg(id: $0.offset, role: $0.element["role"] as? String ?? "note",
                                                 text: $0.element["text"] as? String ?? "") }
            aiBusy = m["busy"] as? Bool ?? false
        default: break
        }
    }

    private func start(kind: Kind, url: String, token: String, title: String, publish: Bool, camera: Bool, mic: Bool) {
        if self.kind != nil { hangUp(tellPage: self.kind != kind) }
        self.kind = kind
        self.title = title
        connecting = true
        startedAt = Date()
        mode = kind == .huddle ? .full : .hidden
        let events = Events(owner: self)
        let room = Room(delegate: events)
        self.events = events
        self.room = room
        Task {
            do {
                try await room.connect(url: url, token: token)
                guard self.room === room else { return }
                // Ask the room to repeat hands / recording we'd otherwise have missed.
                self.publish(["t": "sync"])
                if publish {
                    if camera { try? await room.localParticipant.setCamera(enabled: true) }
                    if mic { try? await room.localParticipant.setMicrophone(enabled: true) }
                }
                self.connecting = false
                self.refresh()
            } catch {
                NSLog("crcmz: call connect failed: \(error)")
                guard self.room === room else { return }
                self.hangUp(tellPage: true)
            }
        }
    }

    // MARK: Controls

    func toggleMic() {
        guard let room else { return }
        let on = !micOn
        micOn = on
        Task { _ = try? await room.localParticipant.setMicrophone(enabled: on); self.refresh() }
    }

    func toggleCamera() {
        guard let room else { return }
        let on = !camOn
        camOn = on
        Task { _ = try? await room.localParticipant.setCamera(enabled: on); self.refresh() }
    }

    func flipCamera() {
        guard let track = room?.localParticipant.firstCameraVideoTrack as? LocalVideoTrack,
              let capturer = track.capturer as? CameraCapturer else { return }
        Task { _ = try? await capturer.switchCameraPosition() }
    }

    func toggleHand() {
        myHand.toggle()
        publish(["t": "hand", "up": myHand])
        onData?(.huddle, ["t": "hand_self", "up": myHand], "You", "me")
        refresh()
    }

    func react(_ e: String) {
        guard Self.reactionSet.contains(e) else { return }
        publish(["t": "rx", "e": e])
        showReaction("You", e)
    }

    /// The AI chat, over the call. The page has the chat history; ask it to send it.
    func openAI() {
        showingAI = true
        onData?(.huddle, ["t": "ai_open"], "You", "me")
    }

    /// Ask the AI. `transcribe`: start the transcript first (so it can follow the call).
    func askAI(_ text: String, transcribe: Bool) {
        let q = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !aiBusy else { return }
        onData?(.huddle, ["t": "ai_ask", "text": String(q.prefix(1000)), "transcribe": transcribe], "You", "me")
    }

    func retryAI() { onData?(.huddle, ["t": "ai_retry"], "You", "me") }

    private func showReaction(_ name: String, _ e: String) {
        reactionSeq += 1
        let id = reactionSeq
        reactions = Array((reactions + [Reaction(id: id, name: name, emoji: e)]).suffix(12))
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.2) { [weak self] in
            self?.reactions.removeAll { $0.id == id }
        }
    }

    // MARK: The data channel and the transcript

    private func publish(_ payload: [String: Any]) {
        guard let room, let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        Task { try? await room.localParticipant.publish(data: data, options: DataPublishOptions(topic: Self.topic, reliable: true)) }
    }

    fileprivate func receive(_ data: Data, from p: RemoteParticipant?, topic: String) {
        guard topic == Self.topic, let p, let kind,
              let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        let id = p.identity?.stringValue ?? ""
        let name = p.name ?? "Someone"
        switch m["t"] as? String {
        case "sync":
            if myHand { publish(["t": "hand", "up": true]) }
            if transcribing { publish(["t": "rec", "on": true]) }
            return
        case "hand":
            if m["up"] as? Bool == true { hands[id] = name } else { hands.removeValue(forKey: id) }
            refresh()
        case "rx":
            if let e = m["e"] as? String, Self.reactionSet.contains(e) { showReaction(name, e) }
        case "rec":
            // Someone turned the transcript on (or off) for the whole call: this phone too.
            if m["all"] as? Bool == true { setTranscript(m["on"] as? Bool == true) }
        default: break
        }
        onData?(kind, m, name, id)
    }

    /// The call screen's Notes button: the transcript on or off for everyone in the call.
    func toggleTranscript() { setTranscript(!transcribing, all: true) }

    /// `all`: tell everyone's phone to do the same (the whole call goes into the notes).
    private func setTranscript(_ on: Bool, all: Bool = false) {
        guard kind == .huddle, on != transcribing else { return }
        if on && !micOn {
            onData?(.huddle, ["t": "transcribing", "on": false, "note": "Unmute your mic to start the transcript."], "You", "me")
            return
        }
        transcribing = on
        if on { transcriber.start() } else { transcriber.stop() }
        publish(all ? ["t": "rec", "on": on, "all": true] : ["t": "rec", "on": on])
        onData?(.huddle, ["t": "transcribing", "on": on,
                          "note": on ? "Transcript on for everyone in the call. The meeting notes are saved when the call ends." : "Transcript off."], "You", "me")
    }

    private func ownLine(_ text: String) {
        publish(["t": "line", "text": text])
        onData?(.huddle, ["t": "line", "text": text], "You", "me")
    }

    func minimize() { mode = .panel }
    func expand() { mode = .full }

    func leave() { hangUp(tellPage: true) }

    private func hangUp(tellPage: Bool) {
        let k = kind
        let r = room
        room = nil
        events = nil
        kind = nil
        tiles = []
        hands = [:]
        myHand = false
        showingAI = false
        reactions = []
        if transcribing { transcriber.stop(); transcribing = false }
        micOn = false
        camOn = false
        connecting = false
        mode = .hidden
        pip.stop()
        Task { await r?.disconnect() }
        if tellPage, let k { onEnded?(k) }
    }

    // MARK: Who's on

    fileprivate func refresh() {
        guard let room else { return }
        let me = room.localParticipant
        micOn = me.isMicrophoneEnabled()
        camOn = me.isCameraEnabled()
        var out: [Tile] = []
        // The Huddle shows you too; the party's panel is for the others (you see the movie).
        if kind == .huddle || camOn {
            out.append(Tile(id: "me", name: "You", track: camOn ? me.firstCameraVideoTrack : nil,
                            speaking: me.isSpeaking, isLocal: true, micOn: micOn, hand: myHand))
        }
        // One person can be on from two tabs; each connection is its own tile.
        for p in room.remoteParticipants.values.sorted(by: { ($0.joinedAt ?? .distantPast) < ($1.joinedAt ?? .distantPast) }) {
            let id = p.identity?.stringValue ?? UUID().uuidString
            let track = p.isCameraEnabled() ? p.firstCameraVideoTrack : nil
            if kind == .watch && track == nil && !p.isMicrophoneEnabled() { continue }   // just watching
            out.append(Tile(id: id, name: p.name ?? "Someone", track: track,
                            speaking: p.isSpeaking, isLocal: false, micOn: p.isMicrophoneEnabled(),
                            hand: hands[id] != nil))
            // A shared screen is its own tile, and the one the window floats.
            if let screen = p.firstScreenShareVideoTrack {
                out.append(Tile(id: id + ":screen", name: "\(p.name ?? "Someone")'s screen", track: screen,
                                speaking: false, isLocal: false, micOn: true, isScreen: true))
            }
        }
        tiles = out
        onTiles?()
        if kind == .watch && mode == .hidden && out.contains(where: { $0.track != nil }) { mode = .panel }
        if kind == .watch && mode == .panel && out.isEmpty { mode = .hidden }
        pip.show(featured?.track)
    }

    /// Who the floating window shows: a shared screen, else whoever's talking, else the
    /// first other camera.
    var featured: Tile? {
        let others = tiles.filter { !$0.isLocal }
        return others.first { $0.isScreen } ?? others.first { $0.speaking && $0.track != nil } ?? others.first { $0.track != nil }
            ?? tiles.first { $0.track != nil }
    }

    /// Room callbacks arrive off the main actor; every one just re-reads who's on.
    private final class Events: RoomDelegate, @unchecked Sendable {
        weak var owner: NativeCall?
        init(owner: NativeCall) { self.owner = owner }
        private func poke() { Task { @MainActor [weak owner] in owner?.refresh() } }

        func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
            Task { @MainActor [weak owner] in
                guard let owner else { return }
                // Newcomers learn who has a hand up and who's recording.
                if owner.myHand { owner.publish(["t": "hand", "up": true]) }
                if owner.transcribing { owner.publish(["t": "rec", "on": true]) }
                owner.refresh()
            }
        }
        func room(_ room: Room, participant: RemoteParticipant?, didReceiveData data: Data, forTopic topic: String,
                  encryptionType: EncryptionType) {
            Task { @MainActor [weak owner] in owner?.receive(data, from: participant, topic: topic) }
        }
        func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
            let id = participant.identity?.stringValue ?? ""
            Task { @MainActor [weak owner] in owner?.hands.removeValue(forKey: id); owner?.refresh() }
        }
        func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) { poke() }
        func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) { poke() }
        func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) { poke() }
        func room(_ room: Room, participant: LocalParticipant, didPublishTrack publication: LocalTrackPublication) { poke() }
        func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) { poke() }
        func room(_ room: Room, participant: Participant, trackPublication: TrackPublication, didUpdateIsMuted isMuted: Bool) { poke() }
        func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
            Task { @MainActor [weak owner] in
                guard let owner, owner.room === room else { return }
                owner.hangUp(tellPage: true)
            }
        }
    }
}

/// The call in picture in picture: the featured camera in Apple's video-call PiP window.
/// It opens by itself when you leave the app with the call on screen, or from the button.
@MainActor
final class CallPip: NSObject, AVPictureInPictureControllerDelegate {
    private var controller: AVPictureInPictureController?
    private let content = AVPictureInPictureVideoCallViewController()
    private let video = VideoView()

    override init() {
        super.init()
        video.renderMode = .sampleBuffer   // PiP needs a sample buffer layer, not Metal
        video.layoutMode = .fill
        video.translatesAutoresizingMaskIntoConstraints = false
        content.preferredContentSize = CGSize(width: 9, height: 16)
        content.view.backgroundColor = .black
        content.view.addSubview(video)
        NSLayoutConstraint.activate([
            video.leadingAnchor.constraint(equalTo: content.view.leadingAnchor),
            video.trailingAnchor.constraint(equalTo: content.view.trailingAnchor),
            video.topAnchor.constraint(equalTo: content.view.topAnchor),
            video.bottomAnchor.constraint(equalTo: content.view.bottomAnchor),
        ])
    }

    static var supported: Bool { AVPictureInPictureController.isPictureInPictureSupported() }

    /// The view PiP grows out of (the call on screen). nil: nothing to float from.
    func attach(to source: UIView?) {
        guard Self.supported else { return }
        guard let source else { controller?.stopPictureInPicture(); controller = nil; return }
        let c = AVPictureInPictureController(contentSource: .init(activeVideoCallSourceView: source,
                                                                   contentViewController: content))
        c.canStartPictureInPictureAutomaticallyFromInline = true
        c.delegate = self
        controller = c
    }

    func show(_ track: VideoTrack?) {
        if video.track !== track { video.track = track }
        if let track { content.preferredContentSize = Self.size(of: track) }
    }

    func start() { controller?.startPictureInPicture() }

    func stop() {
        controller?.stopPictureInPicture()
        video.track = nil
    }

    private static func size(of track: VideoTrack) -> CGSize {
        if let d = (track as? Track)?.dimensions, d.width > 0, d.height > 0 {
            return CGSize(width: Int(d.width), height: Int(d.height))
        }
        return CGSize(width: 9, height: 16)
    }
}
