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
            Controls(call: call, size: 56)
        }
        .padding(.vertical, 8)
        .foregroundStyle(.white)
        .background(ink.ignoresSafeArea())
    }

    private var people: String {
        let n = call.tiles.filter { !$0.isLocal }.count
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
        // Every tile gets an equal cell; the video fills it (cropped), whatever its own shape.
        GeometryReader { g in
            let cols = tiles.count <= 2 ? 1 : 2
            let rows = max(1, Int(ceil(Double(tiles.count) / Double(cols))))
            let w = (g.size.width - CGFloat(cols - 1) * 8) / CGFloat(cols)
            let h = max((g.size.height - CGFloat(rows - 1) * 8) / CGFloat(rows), 120)
            VStack(spacing: 8) {
                ForEach(0..<rows, id: \.self) { r in
                    HStack(spacing: 8) {
                        ForEach(tiles.indices.filter { $0 / cols == r }, id: \.self) { i in
                            TileView(tile: tiles[i], compact: false).frame(width: w, height: h)
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
                SwiftUIVideoView(track, layoutMode: .fill)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Text(initials).font(.system(size: compact ? 20 : 40, weight: .semibold))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            HStack(spacing: 4) {
                if !tile.micOn { Image(systemName: "mic.slash.fill").font(.caption2) }
                if !compact { Text(tile.name).font(.caption).lineLimit(1) }
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Capsule().fill(.black.opacity(0.5)))
            .padding(6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: compact ? 12 : 20))
        .overlay(RoundedRectangle(cornerRadius: compact ? 12 : 20)
            .stroke(tile.speaking ? accent : .clear, lineWidth: 3))
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

    /// Tiles come and go: the panel grows or shrinks to fit them.
    func tilesChanged() { if call.mode == .panel { layout(animated: true) } }
}
