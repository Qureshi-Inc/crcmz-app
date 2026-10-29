import ActivityKit
import AppIntents
import SwiftUI
import UIKit

// The Watch Party's Live Activity: the lock screen card and the Dynamic Island. It answers
// what's on, who's watching and how to join, from the server's shared state (live.py
// _state, the same one Android's notification draws). The phone runs the clock and bar
// itself from elapsed / duration / rate as of `at`; nothing updates it every second.

// MARK: - Colours: restrained purple, light and dark

enum LivePalette {
    static let accent = dynamic(dark: 0xB98AFF, light: 0x6D28D9)
    static let background = dynamic(dark: 0x0F0B1A, light: 0xF7F4FD)
    static let text = dynamic(dark: 0xF4EFFF, light: 0x1A1430)
    static let dim = dynamic(dark: 0xAFA4CC, light: 0x574E73)
    static let tile = dynamic(dark: 0x251B3D, light: 0xE9E1FA)
    static let live = Color(red: 1, green: 0.27, blue: 0.36)

    private static func dynamic(dark: UInt32, light: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) })
    }
    private static func rgb(_ v: UInt32) -> UIColor {
        UIColor(red: CGFloat(v >> 16 & 0xFF) / 255, green: CGFloat(v >> 8 & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }
}

// MARK: - The state, read once

enum PartyStatus: String {
    case playing, paused, stale, ended

    var label: String {
        switch self {
        case .playing: return "LIVE"
        case .paused: return "PAUSED"
        case .stale: return "RECONNECTING"
        case .ended: return "ENDED"
        }
    }
    var symbol: String {
        switch self {
        case .playing: return "circle.fill"
        case .paused: return "pause.fill"
        case .stale: return "arrow.triangle.2.circlepath"
        case .ended: return "stop.fill"
        }
    }
    var spoken: String {
        switch self {
        case .playing: return "Live"
        case .paused: return "Paused"
        case .stale: return "Reconnecting"
        case .ended: return "Ended"
        }
    }
}

/// One Watch Party, as the views need it. `stale`: the system says no update has come for a
/// while (the server sends one at least every 10 minutes), so it isn't shown as live.
struct PartyNow {
    let s: CRCMZLiveAttributes.ContentState
    let key: String
    let status: PartyStatus
    let clock: FilmClock?

    init(_ s: CRCMZLiveAttributes.ContentState, key: String = "", stale: Bool = false) {
        self.s = s
        self.key = key
        let sent = PartyStatus(rawValue: s.status ?? "") ?? (s.paused ? .paused : .playing)
        status = sent == .ended ? .ended : (stale ? .stale : sent)
        clock = status == .ended ? nil : FilmClock(s, playing: status == .playing)
    }

    var session: String { s.session ?? key }
    var title: String { s.title.isEmpty ? "Watch party" : s.title }
    var joined: Bool { s.joined ?? false }
    var isPrivate: Bool { s.private ?? false }
    var ended: Bool { status == .ended }

    /// "3 watching", "1.2K watching", or nobody yet.
    var watching: String {
        s.count <= 0 ? "No one watching yet" : "\(s.count.formatted(.number.notation(.compactName))) watching"
    }

    /// "Moiz, Noor +1": the server's summary, or (older servers) up to two names, then how many more.
    var people: String {
        if let p = s.people { return p }
        let shown = s.names.filter { !$0.isEmpty }.prefix(2)
        guard !shown.isEmpty else { return "" }
        let more = max(0, s.count - shown.count)
        return shown.joined(separator: ", ") + (more > 0 ? " +\(more.formatted(.number.notation(.compactName)))" : "")
    }

    /// "3 watching · 1h 30m left"; "The party has ended".
    var line: String {
        if ended { return "The party has ended" }
        guard let c = clock else { return watching }
        return watching + " · " + FilmClock.left(c.duration - c.now)
    }

    /// For VoiceOver: the whole card in one sentence.
    var spoken: String {
        var parts = ["Watch party", status.spoken, title, line.replacingOccurrences(of: " · ", with: ", ")]
        if !people.isEmpty && !isPrivate { parts.append("with " + people.replacingOccurrences(of: " +", with: " and ") + (people.contains("+") ? " more" : "")) }
        if let c = clock { parts.append("\(FilmClock.clock(c.now)) of \(FilmClock.clock(c.duration))") }
        return parts.joined(separator: ". ")
    }
}

/// Where the film is: its position and length (seconds) as of `at`, running at `rate`.
/// Playing at normal speed, the clock and bar run by themselves (system timers); paused,
/// reconnecting or at any other speed they stand where they were. nil without a length.
struct FilmClock {
    let elapsed: Double
    let duration: Double
    let at: Double
    let rate: Double
    let playing: Bool

    init?(_ s: CRCMZLiveAttributes.ContentState, playing: Bool) {
        guard let d = s.duration, d > 60 else { return nil }
        duration = d
        elapsed = min(d, max(0, s.elapsed ?? 0))
        at = s.at ?? Date().timeIntervalSince1970
        rate = s.rate ?? 1
        self.playing = playing && rate > 0
    }

    /// Where it is right now.
    var now: Double {
        guard playing else { return elapsed }
        return min(duration, elapsed + max(0, Date().timeIntervalSince1970 - at) * rate)
    }
    /// When it would have started, at normal speed, to be where it was at `at`.
    var start: Date { Date(timeIntervalSince1970: at - elapsed) }
    var end: Date { start.addingTimeInterval(duration) }
    /// The system's timers only run at normal speed.
    var ticking: Bool { playing && rate == 1 && Date() < end }
    var fraction: Double { min(1, now / duration) }

    /// "23:00 / 1:53:00", counting by itself while it plays.
    var position: Text {
        ticking ? Text(timerInterval: start...end, countsDown: false) + Text(" / " + Self.clock(duration))
                : Text(Self.clock(now) + " / " + Self.clock(duration))
    }

    /// 1:53:00, or 23:00 under an hour.
    static func clock(_ sec: Double) -> String {
        let t = Int(max(0, sec)), h = t / 3600, m = t % 3600 / 60, s = t % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    /// 1h 30m left, 45m left, Under a minute left.
    static func left(_ sec: Double) -> String {
        let t = Int(max(0, sec)), h = t / 3600, m = (t % 3600 + 59) / 60
        if t < 60 { return "Under a minute left" }
        if h > 0 && (1...59).contains(m) { return "\(h)h \(m)m left" }
        return h > 0 ? "\(h)h left" : "\(m)m left"
    }
}

// MARK: - Pieces

/// LIVE / PAUSED / RECONNECTING / ENDED: a symbol and a word, never colour alone.
struct StatusChip: View {
    let status: PartyStatus
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: status.symbol).font(.system(size: status == .playing ? 6 : 8, weight: .bold))
                .foregroundStyle(status == .playing ? LivePalette.live : LivePalette.dim)
            Text(status.label).font(.caption2.weight(.heavy)).lineLimit(1)
                .foregroundStyle(status == .playing ? LivePalette.text : LivePalette.dim)
        }
        .padding(.horizontal, 7).padding(.vertical, 3)
        .background(Capsule().fill(LivePalette.tile))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(status.spoken)
    }
}

/// The poster, small; without one (none, not fetched yet, or private), the party's symbol on a tile.
struct PartyArtwork: View {
    let party: PartyNow
    let width: CGFloat
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: width * 0.16, style: .continuous)
        Group {
            if !party.isPrivate, let img = LivePoster.image(for: party.s.poster) {
                Image(uiImage: img).resizable().aspectRatio(contentMode: .fill)
            } else {
                ZStack {
                    LivePalette.tile
                    Image(systemName: "play.tv.fill").font(.system(size: width * 0.4)).foregroundStyle(LivePalette.accent)
                }
            }
        }
        .frame(width: width, height: width * 1.5)
        .clipShape(shape)
        .privacySensitive()
        .accessibilityHidden(true)
    }
}

/// The thin, read-only bar: fills by itself while the film plays.
struct FilmBar: View {
    let clock: FilmClock
    var body: some View {
        Group {
            if clock.ticking {
                ProgressView(timerInterval: clock.start...clock.end, countsDown: false) { EmptyView() } currentValueLabel: { EmptyView() }
            } else {
                ProgressView(value: clock.fraction)
            }
        }
        .progressViewStyle(.linear)
        .tint(LivePalette.accent)
        .accessibilityHidden(true)
    }
}

/// Join party (Open party when you're in it): opens that party in the app, through sign-in if need be.
struct JoinButton: View {
    let party: PartyNow
    var body: some View {
        Link(destination: AppLink.url(party.s.url)) {
            Text(party.joined ? "Open party" : "Join party")
                .font(.footnote.weight(.semibold)).lineLimit(1)
                .foregroundStyle(.white)
                .padding(.horizontal, 14).padding(.vertical, 7)
                .background(Capsule().fill(LivePalette.accent))
        }
        .layoutPriority(2)
    }
}

/// Hide: this party's Live Activity off this phone (iOS 17+, an App Intent). Leaves the
/// party, the film and everyone else alone; the next party shows again.
struct HideButton: View {
    let party: PartyNow
    var body: some View {
        if #available(iOS 17.0, *) {
            Button(intent: HideLiveIntent(key: party.key, session: party.session)) {
                Text("Hide").font(.footnote.weight(.semibold)).lineLimit(1)
                    .foregroundStyle(LivePalette.text)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(Capsule().fill(LivePalette.tile))
            }
            .buttonStyle(.plain)
        }
    }
}

// MARK: - Lock screen (and the banner on phones without a Dynamic Island)

/// CRCMZ · Watch party · LIVE, the film, "3 watching · 1h 30m left", "Moiz, Noor +1", the
/// poster; a thin bar; "23:00 / 1:53:00", Hide and Join party. Within the lock screen's
/// 160 points; at the largest text sizes, the film and Join party come first.
struct WatchCard: View {
    let party: PartyNow
    @Environment(\.dynamicTypeSize) private var type

    var body: some View {
        let big = type >= .xxLarge
        VStack(alignment: .leading, spacing: big ? 6 : 8) {
            HStack(alignment: .top, spacing: 12) {
                if !big { PartyArtwork(party: party, width: 44) }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text("CRCMZ · Watch party").font(.caption2.weight(.semibold)).foregroundStyle(LivePalette.dim).lineLimit(1)
                        Spacer(minLength: 4)
                        StatusChip(status: party.status)
                    }
                    Text(party.title).font(.headline).foregroundStyle(LivePalette.text)
                        .lineLimit(1).minimumScaleFactor(0.8).privacySensitive().layoutPriority(1)
                    Text(party.line).font(.subheadline).foregroundStyle(LivePalette.dim).lineLimit(1)
                    if !big && !party.people.isEmpty && !party.ended {
                        Text(party.people).font(.caption).foregroundStyle(LivePalette.dim).lineLimit(1).privacySensitive()
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(party.spoken)
            }
            if let c = party.clock { FilmBar(clock: c) }
            if !party.ended {
                HStack(spacing: 8) {
                    if let c = party.clock, !big {
                        c.position.font(.caption.monospacedDigit()).foregroundStyle(LivePalette.dim).lineLimit(1)
                            .accessibilityHidden(true)
                    }
                    Spacer(minLength: 4)
                    if !big { HideButton(party: party) }
                    JoinButton(party: party)
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

// MARK: - Dynamic Island

/// Compact, leading: the party's symbol.
struct WatchCompactLeading: View {
    let party: PartyNow
    var body: some View {
        Image(systemName: "play.tv.fill")
            .foregroundStyle(party.status == .playing ? LivePalette.accent : LivePalette.dim)
            .accessibilityLabel("Watch party, " + party.status.spoken)
    }
}

/// Compact, trailing: how many are watching.
struct WatchCompactTrailing: View {
    let party: PartyNow
    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: party.status == .playing ? "person.2.fill" : party.status.symbol).font(.caption2)
            Text(party.s.count.formatted(.number.notation(.compactName))).font(.caption.weight(.semibold)).monospacedDigit()
        }
        .foregroundStyle(LivePalette.text)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(party.watching)
    }
}

/// Minimal (another app's activity has the island too): just the party's symbol.
struct WatchMinimal: View {
    let party: PartyNow
    var body: some View {
        Image(systemName: "play.tv.fill").foregroundStyle(LivePalette.accent)
            .accessibilityLabel("Watch party, " + party.watching)
    }
}

/// Expanded, leading: the poster.
struct WatchIslandLeading: View {
    let party: PartyNow
    var body: some View { PartyArtwork(party: party, width: 36).padding(.leading, 4) }
}

/// Expanded, trailing: LIVE / PAUSED / RECONNECTING / ENDED.
struct WatchIslandTrailing: View {
    let party: PartyNow
    var body: some View { StatusChip(status: party.status).padding(.trailing, 4) }
}

/// Expanded, centre: the film and the head count.
struct WatchIslandCenter: View {
    let party: PartyNow
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(party.title).font(.headline).foregroundStyle(LivePalette.text).lineLimit(1).minimumScaleFactor(0.8).privacySensitive()
            Text(party.line).font(.caption).foregroundStyle(LivePalette.dim).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(party.spoken)
    }
}

/// Expanded, bottom: the bar, "23:00 / 1:53:00", and Join party (with Hide if there's room).
struct WatchIslandBottom: View {
    let party: PartyNow
    var body: some View {
        VStack(spacing: 6) {
            if let c = party.clock { FilmBar(clock: c) }
            if !party.ended {
                HStack(spacing: 8) {
                    if let c = party.clock {
                        c.position.font(.caption2.monospacedDigit()).foregroundStyle(LivePalette.dim).lineLimit(1).accessibilityHidden(true)
                    }
                    Spacer(minLength: 4)
                    HideButton(party: party)
                    JoinButton(party: party)
                }
            }
        }
        .padding(.horizontal, 4)
    }
}

// MARK: - Hide (App Intent)

/// Hide on the lock screen or in the Dynamic Island (iOS 17+). The system runs it in the
/// app: it ends this party's activity on this phone at once, and tells the server, so a
/// push doesn't start it again before the party's over.
@available(iOS 17.0, *)
struct HideLiveIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Hide this Watch Party"
    static var isDiscoverable = false

    @Parameter(title: "Key") var key: String
    @Parameter(title: "Session") var session: String

    init() {}
    init(key: String, session: String) {
        self.key = key
        self.session = session
    }

    func perform() async throws -> some IntentResult {
        for a in Activity<CRCMZLiveAttributes>.activities where a.attributes.key == key {
            await a.end(nil, dismissalPolicy: .immediate)
        }
        await LiveAPI.post(["hide": session])
        return .result()
    }
}

/// POST /api/live/ios as you (the session the app shares with its extensions).
enum LiveAPI {
    @discardableResult
    static func post(_ body: [String: Any]) async -> Bool {
        guard let session = SharedSession.read() else { return false }
        var rq = URLRequest(url: URL(string: "https://app.crcmz.me/api/live/ios")!)
        rq.httpMethod = "POST"
        rq.timeoutInterval = 20
        rq.setValue("https://app.crcmz.me", forHTTPHeaderField: "Origin")
        rq.setValue("psn_session=\(session)", forHTTPHeaderField: "Cookie")
        rq.setValue("application/json", forHTTPHeaderField: "Content-Type")
        rq.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (_, resp) = try? await URLSession.shared.data(for: rq) else { return false }
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }
}
