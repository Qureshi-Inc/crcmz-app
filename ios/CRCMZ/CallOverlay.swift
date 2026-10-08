import LiveKit
import SwiftUI
import UIKit

/// The native call on top of the web page (NativeCall): full screen for a Huddle, or a
/// small panel you can drag around (the party's cameras over the movie, or a minimised
/// Huddle). WebController sizes the host view to the mode, so the page under a panel
/// keeps working.
struct CallOverlay: View {
    @ObservedObject var call: NativeCall

    var body: some View {
        switch call.mode {
        case .full: FullCall(call: call)
        case .panel: PanelCall(call: call)
        case .hidden: Color.clear
        }
    }
}

private let ink = Color(red: 0.02, green: 0.012, blue: 0.06)
private let accent = Color(red: 0.55, green: 0.42, blue: 1.0)

private struct FullCall: View {
    @ObservedObject var call: NativeCall

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Button { call.minimize() } label: { Image(systemName: "chevron.down") }
                    .buttonStyle(Round(size: 40)).accessibilityLabel("Minimise the call")
                Spacer()
                VStack(spacing: 2) {
                    Text(call.title).font(.headline)
                    Text(call.connecting ? "Connecting…" : people).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if CallPip.supported {
                    Button { call.pip.start() } label: { Image(systemName: "pip.enter") }
                        .buttonStyle(Round(size: 40)).accessibilityLabel("Picture in picture")
                } else { Color.clear.frame(width: 40, height: 40) }
            }
            .padding(.horizontal)
            Grid(tiles: call.tiles)
                .overlay(ReactionsLayer(reactions: call.reactions))
            if call.kind == .huddle { Extras(call: call) }
            Controls(call: call, size: 56)
        }
        .padding(.vertical, 8)
        .foregroundStyle(.white)
        .background(ink.ignoresSafeArea())
        // The AI chat slides up over the call; the call keeps going above it.
        .sheet(isPresented: $call.showingAI) {
            AiChat(call: call)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        }
    }

    private var people: String {
        let n = call.tiles.filter { !$0.isLocal && !$0.isScreen }.count
        return n == 0 ? "Waiting for the squad" : n == 1 ? "1 other person" : "\(n) others"
    }
}

private struct PanelCall: View {
    @ObservedObject var call: NativeCall

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                ForEach(shown) { TileView(tile: $0, compact: true).frame(width: tileWidth, height: tileWidth * 4 / 3) }
            }
            .frame(maxHeight: .infinity)
            .overlay(ReactionsLayer(reactions: call.reactions, small: true))
            .onTapGesture { call.expand() }
            if call.kind == .huddle || call.camOn || call.micOn {
                Controls(call: call, size: 34)
            }
        }
        .padding(6)
        .foregroundStyle(.white)
        .background(RoundedRectangle(cornerRadius: 18).fill(ink.opacity(0.85)))
    }

    private var tileWidth: CGFloat { call.kind == .huddle ? 120 : 84 }

    /// A Huddle shrinks to whoever's talking; the party shows everyone on camera.
    private var shown: [NativeCall.Tile] {
        if call.kind == .huddle { return call.featured.map { [$0] } ?? Array(call.tiles.prefix(1)) }
        return Array(call.tiles.prefix(4))
    }
}

private struct Grid: View {
    let tiles: [NativeCall.Tile]

    var body: some View {
        // Every camera gets an equal cell, the video filling it (cropped). A shared screen
        // goes on top, the full width and twice as tall, shown whole.
        GeometryReader { g in
            let screens = tiles.filter { $0.isScreen }
            let people = tiles.filter { !$0.isScreen }
            let cols = people.count <= 2 && screens.isEmpty ? 1 : 2
            let rows = max(1, Int(ceil(Double(people.count) / Double(cols))))
            let units = CGFloat(rows + screens.count * 2)
            let gaps = CGFloat(rows + screens.count - 1) * 8
            let unit = max((g.size.height - gaps) / max(units, 1), 60)
            let w = (g.size.width - CGFloat(cols - 1) * 8) / CGFloat(cols)
            VStack(spacing: 8) {
                ForEach(screens) { t in
                    TileView(tile: t, compact: false).frame(width: g.size.width, height: unit * 2)
                }
                ForEach(0..<rows, id: \.self) { r in
                    HStack(spacing: 8) {
                        ForEach(people.indices.filter { $0 / cols == r }, id: \.self) { i in
                            TileView(tile: people[i], compact: false).frame(width: w, height: max(unit, 120))
                        }
                    }
                }
            }
            .frame(width: g.size.width, height: g.size.height, alignment: .top)
        }
        .padding(.horizontal, 8)
    }
}

private struct TileView: View {
    let tile: NativeCall.Tile
    let compact: Bool

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            RoundedRectangle(cornerRadius: compact ? 12 : 20).fill(Color.white.opacity(0.08))
            if let track = tile.track {
                // The cell decides the size, never the video's own dimensions (that's what
                // squeezed other people into thin tubes).
                SwiftUIVideoView(track, layoutMode: tile.isScreen ? .fit : .fill)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Text(initials).font(.system(size: compact ? 20 : 40, weight: .semibold))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if tile.hand {
                Text("✋").font(.system(size: compact ? 14 : 20)).padding(compact ? 3 : 5)
                    .background(Capsule().fill(.black.opacity(0.6))).padding(6)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .accessibilityLabel("\(tile.name) has a hand up")
            }
            HStack(spacing: 4) {
                if tile.isScreen { Image(systemName: "rectangle.on.rectangle").font(.caption2) }
                else if !tile.micOn { Image(systemName: "mic.slash.fill").font(.caption2) }
                if !compact { Text(tile.name).font(.caption).lineLimit(1) }
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Capsule().fill(.black.opacity(0.5)))
            .padding(6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: compact ? 12 : 20))
        .overlay(RoundedRectangle(cornerRadius: compact ? 12 : 20)
            .stroke(tile.speaking ? accent : tile.hand ? Color.yellow : .clear, lineWidth: 3))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(tile.name + (tile.speaking ? ", talking" : ""))
    }

    private var initials: String {
        let parts = tile.name.split(separator: " ").prefix(2)
        return parts.map { String($0.prefix(1)).uppercased() }.joined()
    }
}

private struct Controls: View {
    @ObservedObject var call: NativeCall
    let size: CGFloat

    var body: some View {
        HStack(spacing: size / 3) {
            Button { call.toggleMic() } label: { Image(systemName: call.micOn ? "mic.fill" : "mic.slash.fill") }
                .buttonStyle(Round(size: size, on: call.micOn))
                .accessibilityLabel(call.micOn ? "Mute mic" : "Unmute mic")
            Button { call.toggleCamera() } label: { Image(systemName: call.camOn ? "video.fill" : "video.slash.fill") }
                .buttonStyle(Round(size: size, on: call.camOn))
                .accessibilityLabel(call.camOn ? "Camera off" : "Camera on")
            if call.camOn && size > 40 {
                Button { call.flipCamera() } label: { Image(systemName: "arrow.triangle.2.circlepath.camera") }
                    .buttonStyle(Round(size: size)).accessibilityLabel("Flip camera")
            }
            Button { call.leave() } label: { Image(systemName: "phone.down.fill") }
                .buttonStyle(Round(size: size, tint: .red)).accessibilityLabel("Leave call")
        }
    }
}

/// The AI chat over the call. The page keeps the conversation (so it's all still there
/// when you close this and come back, and the same on the Huddle page) and asks the AI;
/// this shows it and sends your questions. Asking with the transcript off offers to
/// start it first, since that's how the AI follows the call.
private struct AiChat: View {
    @ObservedObject var call: NativeCall
    @State private var text = ""
    @State private var pending: String?
    @FocusState private var typing: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label("AI helper", systemImage: "sparkles").font(.headline)
                Spacer()
                if call.transcribing {
                    Label("Transcribing", systemImage: "waveform").font(.caption.weight(.semibold))
                        .padding(.horizontal, 10).padding(.vertical, 5).background(Capsule().fill(Color.red.opacity(0.25)))
                }
                Button { call.showingAI = false } label: { Image(systemName: "xmark") }
                    .buttonStyle(Round(size: 34)).accessibilityLabel("Close the AI chat")
            }
            .padding(.horizontal).padding(.top, 14).padding(.bottom, 8)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if call.aiLog.isEmpty {
                            Text(call.transcribing ? "Ask about the call: what was decided, who's doing what, or anything else."
                                 : "Ask the AI anything. With the transcript on, it follows the call too.")
                                .font(.subheadline).foregroundStyle(.secondary).padding(.top, 8)
                        }
                        ForEach(call.aiLog) { m in Bubble(msg: m, retry: { call.retryAI() }).id(m.id) }
                        if call.aiBusy {
                            HStack(spacing: 8) { ProgressView().tint(.white); Text("Thinking…").foregroundStyle(.secondary) }
                                .font(.subheadline).id(-1)
                        }
                    }
                    .padding(.horizontal).padding(.bottom, 8)
                }
                .scrollDismissesKeyboard(.interactively)
                .onAppear { proxy.scrollTo(call.aiLog.last?.id, anchor: .bottom) }
                .onChange(of: call.aiLog.count) { _ in withAnimation { proxy.scrollTo(call.aiBusy ? -1 : call.aiLog.last?.id, anchor: .bottom) } }
                .onChange(of: call.aiBusy) { busy in withAnimation { proxy.scrollTo(busy ? -1 : call.aiLog.last?.id, anchor: .bottom) } }
            }
            HStack(spacing: 8) {
                TextField("Ask the AI", text: $text, axis: .vertical)
                    .lineLimit(1...4).focused($typing).submitLabel(.send)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 20).fill(Color.white.opacity(0.1)))
                    .onSubmit(send)
                Button(action: send) { Image(systemName: "arrow.up") }
                    .buttonStyle(Round(size: 40, on: !text.isEmpty))
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || call.aiBusy)
                    .accessibilityLabel("Ask")
            }
            .padding(.horizontal).padding(.vertical, 10)
        }
        .foregroundStyle(.white)
        .background(ink.ignoresSafeArea())
        .confirmationDialog("Start the transcript?", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                            titleVisibility: .visible) {
            Button("Start and ask") { ask(transcribe: true) }
            Button("Just ask") { ask(transcribe: false) }
            Button("Cancel", role: .cancel) { pending = nil }
        } message: {
            Text("The AI follows the call through the transcript. It starts for everyone in the call, and the meeting notes are saved when the call ends.")
        }
    }

    private func send() {
        let q = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !call.aiBusy else { return }
        if call.transcribing { call.askAI(q, transcribe: false); text = "" } else { pending = q }
    }

    private func ask(transcribe: Bool) {
        guard let q = pending else { return }
        call.askAI(q, transcribe: transcribe)
        pending = nil
        text = ""
    }
}

private struct Bubble: View {
    let msg: NativeCall.AiMsg
    let retry: () -> Void

    var body: some View {
        switch msg.role {
        case "user":
            HStack { Spacer(minLength: 40); Text(msg.text).padding(10).background(RoundedRectangle(cornerRadius: 16).fill(accent.opacity(0.45))) }
        case "assistant":
            Text((try? AttributedString(markdown: msg.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(msg.text))
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.08)))
                .textSelection(.enabled)
        case "error":
            HStack {
                Text(msg.text).foregroundStyle(Color(red: 1, green: 0.55, blue: 0.55))
                Button("Try again", action: retry).font(.subheadline.weight(.semibold))
            }
        default:
            Text(msg.text).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .center)
        }
    }
}

/// Huddle extras: your hand, a reaction, the transcript, the AI chat.
private struct Extras: View {
    @ObservedObject var call: NativeCall
    @State private var picking = false

    var body: some View {
        VStack(spacing: 8) {
            if picking {
                HStack(spacing: 4) {
                    ForEach(NativeCall.reactionSet, id: \.self) { e in
                        Button { call.react(e) } label: { Text(e).font(.system(size: 26)) }
                            .frame(width: 44, height: 44).accessibilityLabel("Send \(e)")
                    }
                }
                .padding(4).background(Capsule().fill(Color.white.opacity(0.12)))
            }
            HStack(spacing: 10) {
                Button { call.toggleHand() } label: { Label(call.myHand ? "Lower" : "Hand", systemImage: "hand.raised.fill") }
                    .buttonStyle(Pill(on: call.myHand)).accessibilityLabel(call.myHand ? "Lower your hand" : "Raise your hand")
                Button { picking.toggle() } label: { Label("React", systemImage: "face.smiling") }
                    .buttonStyle(Pill(on: picking))
                Button { call.toggleTranscript() } label: { Label(call.transcribing ? "Stop" : "Transcribe", systemImage: call.transcribing ? "stop.circle" : "waveform") }
                    .buttonStyle(Pill(on: call.transcribing))
                    .accessibilityLabel(call.transcribing ? "Stop the transcript" : "Transcribe this call, for meeting notes when it ends")
                Button { call.toggleScreenShare() }
                    label: { Label(call.screenShareOn ? "Sharing" : "Screen", systemImage: "rectangle.on.rectangle") }
                    .buttonStyle(Pill(on: call.screenShareOn))
                    .accessibilityLabel(call.screenShareOn ? "Stop sharing screen" : "Share your screen")
                Button { call.openAI() } label: { Label("AI", systemImage: "sparkles") }
                    .buttonStyle(Pill()).accessibilityLabel("AI helper")
            }
        }
    }
}

private struct Pill: ButtonStyle {
    var on = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 14).frame(minHeight: 44)
            .background(Capsule().fill(on ? Color.white.opacity(0.28) : Color.white.opacity(0.12)))
            .foregroundStyle(.white)
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

/// Reactions float up over the call and fade.
private struct ReactionsLayer: View {
    let reactions: [NativeCall.Reaction]
    var small = false

    var body: some View {
        GeometryReader { g in
            ForEach(reactions) { r in
                Floating(r: r, small: small)
                    .position(x: g.size.width * (0.15 + CGFloat((r.id * 37) % 70) / 100), y: g.size.height * 0.85)
            }
        }
        .allowsHitTesting(false)
    }

    private struct Floating: View {
        let r: NativeCall.Reaction
        let small: Bool
        @State private var up = false
        var body: some View {
            VStack(spacing: 2) {
                Text(r.emoji).font(.system(size: small ? 22 : 36))
                if !small {
                    Text(r.name).font(.caption2.weight(.bold)).padding(.horizontal, 6)
                        .background(Capsule().fill(.black.opacity(0.6)))
                }
            }
            .offset(y: up ? (small ? -60 : -200) : 0)
            .opacity(up ? 0 : 1)
            .onAppear { withAnimation(.easeOut(duration: 3)) { up = true } }
            .accessibilityLabel("\(r.name) reacted \(r.emoji)")
        }
    }
}

private struct Round: ButtonStyle {
    var size: CGFloat
    var on = false
    var tint: Color? = nil

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: size * 0.4, weight: .semibold))
            .frame(width: size, height: size)
            .background(Circle().fill(tint ?? (on ? Color.white.opacity(0.28) : Color.white.opacity(0.14))))
            .foregroundStyle(.white)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .frame(minWidth: 44, minHeight: 44)
    }
}

/// Hosts the overlay over the web view and keeps it the right size for its mode.
@MainActor
final class CallHost {
    private let call = NativeCall.shared
    private let host: UIHostingController<CallOverlay>
    private weak var parent: UIViewController?
    private var panelOrigin: CGPoint?

    init(in parent: UIViewController) {
        self.parent = parent
        host = UIHostingController(rootView: CallOverlay(call: NativeCall.shared))
        host.view.backgroundColor = .clear
        host.view.isHidden = true
        host.view.layer.cornerCurve = .continuous
        parent.addChild(host)
        parent.view.addSubview(host.view)
        host.didMove(toParent: parent)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(drag(_:)))
        host.view.addGestureRecognizer(pan)
        call.onMode = { [weak self] _ in self?.layout(animated: true) }
    }

    func layout(animated: Bool = false) {
        guard let parent else { return }
        let bounds = parent.view.bounds
        let mode = call.mode
        let apply = { [self] in
            switch mode {
            case .hidden:
                host.view.isHidden = true
            case .full:
                host.view.isHidden = false
                host.view.layer.cornerRadius = 0
                host.view.frame = bounds
            case .panel:
                host.view.isHidden = false
                host.view.layer.cornerRadius = 18
                let size = panelSize(in: bounds)
                let safe = parent.view.safeAreaInsets
                let origin = panelOrigin ?? CGPoint(x: bounds.width - size.width - 12,
                                                    y: bounds.height - size.height - safe.bottom - 96)
                host.view.frame = CGRect(origin: clamp(origin, size: size, in: bounds), size: size)
            }
        }
        if animated { UIView.animate(withDuration: 0.28, delay: 0, options: [.curveEaseInOut], animations: apply) }
        else { apply() }
        parent.view.bringSubviewToFront(host.view)
        call.pip.attach(to: mode == .hidden ? nil : host.view)
    }

    private func panelSize(in bounds: CGRect) -> CGSize {
        let controls: CGFloat = (call.kind == .huddle || call.camOn || call.micOn) ? 50 : 0
        let n = call.kind == .huddle ? 1 : max(1, min(call.tiles.count, 4))
        let tileW: CGFloat = call.kind == .huddle ? 120 : 84
        let w = max(CGFloat(n) * (tileW + 6) + 6, controls > 0 ? 200 : 0)
        return CGSize(width: min(w, bounds.width - 24), height: tileW * 4 / 3 + 12 + controls)
    }

    private func clamp(_ p: CGPoint, size: CGSize, in b: CGRect) -> CGPoint {
        let safe = parent?.view.safeAreaInsets ?? .zero
        return CGPoint(x: min(max(p.x, 8), b.width - size.width - 8),
                       y: min(max(p.y, safe.top + 8), b.height - size.height - safe.bottom - 8))
    }

    @objc private func drag(_ g: UIPanGestureRecognizer) {
        guard call.mode == .panel, let parent else { return }
        let t = g.translation(in: parent.view)
        var f = host.view.frame
        f.origin = clamp(CGPoint(x: f.origin.x + t.x, y: f.origin.y + t.y), size: f.size, in: parent.view.bounds)
        host.view.frame = f
        g.setTranslation(.zero, in: parent.view)
        if g.state == .ended { panelOrigin = f.origin }
    }

    /// The AI helper is on the page with its input at the bottom: the panel goes up top.
    func panelToTop() {
        guard let parent else { return }
        let size = panelSize(in: parent.view.bounds)
        panelOrigin = CGPoint(x: parent.view.bounds.width - size.width - 12, y: parent.view.safeAreaInsets.top + 64)
        layout(animated: true)
    }

    /// Tiles come and go: the panel grows or shrinks to fit them.
    func tilesChanged() { if call.mode == .panel { layout(animated: true) } }

    /// Re-raise the call overlay above any sheets or the WKWebView that may have appeared
    /// on top while the app was in the background.
    func bringOverlayToFront() {
        guard let parent, !host.view.isHidden else { return }
        parent.view.bringSubviewToFront(host.view)
    }
}
