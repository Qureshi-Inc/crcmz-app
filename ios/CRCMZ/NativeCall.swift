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
///
/// Leave here hangs up and tells the page (window.__crcmzCallEnded).
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
    }

    @Published private(set) var kind: Kind?
    @Published private(set) var title = ""
    @Published private(set) var tiles: [Tile] = []
    @Published private(set) var micOn = false
    @Published private(set) var camOn = false
    @Published private(set) var connecting = false
    @Published var mode: Mode = .hidden { didSet { if mode != oldValue { onMode?(mode) } } }

    var onMode: ((Mode) -> Void)?
    var onTiles: (() -> Void)?
    var onEnded: ((Kind) -> Void)?

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
                            speaking: me.isSpeaking, isLocal: true, micOn: micOn))
        }
        // One person can be on from two tabs; each connection is its own tile.
        for p in room.remoteParticipants.values.sorted(by: { ($0.joinedAt ?? .distantPast) < ($1.joinedAt ?? .distantPast) }) {
            let id = p.identity?.stringValue ?? UUID().uuidString
            let track = p.isCameraEnabled() ? p.firstCameraVideoTrack : nil
            if kind == .watch && track == nil && !p.isMicrophoneEnabled() { continue }   // just watching
            out.append(Tile(id: id, name: p.name ?? "Someone", track: track,
                            speaking: p.isSpeaking, isLocal: false, micOn: p.isMicrophoneEnabled()))
        }
        tiles = out
        onTiles?()
        if kind == .watch && mode == .hidden && out.contains(where: { $0.track != nil }) { mode = .panel }
        if kind == .watch && mode == .panel && out.isEmpty { mode = .hidden }
        pip.show(featured?.track)
    }

    /// Who the floating window shows: whoever's talking, else the first other camera.
    var featured: Tile? {
        let others = tiles.filter { !$0.isLocal }
        return others.first { $0.speaking && $0.track != nil } ?? others.first { $0.track != nil }
            ?? tiles.first { $0.track != nil }
    }

    /// Room callbacks arrive off the main actor; every one just re-reads who's on.
    private final class Events: RoomDelegate, @unchecked Sendable {
        weak var owner: NativeCall?
        init(owner: NativeCall) { self.owner = owner }
        private func poke() { Task { @MainActor [weak owner] in owner?.refresh() } }

        func room(_ room: Room, participantDidConnect participant: RemoteParticipant) { poke() }
        func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) { poke() }
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
