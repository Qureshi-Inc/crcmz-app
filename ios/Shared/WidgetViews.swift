import SwiftUI

/// The widgets' and the Live Activity's looks, as plain SwiftUI: the widget extension
/// (CRCMZWidgets) shows them, and a debug build of the app can lay them out for a
/// screenshot (-crcmzWidgetDemo, WidgetGallery). Data is GET /api/widgets/summary.

enum Brand {
    static let ink = Color(red: 5 / 255, green: 3 / 255, blue: 15 / 255)          // #05030f
    static let panel = Color(red: 22 / 255, green: 13 / 255, blue: 46 / 255)
    static let magenta = Color(red: 1, green: 47 / 255, blue: 214 / 255)          // #ff2fd6
    static let cyan = Color(red: 34 / 255, green: 230 / 255, blue: 1)             // #22e6ff
    static let text = Color(red: 243 / 255, green: 236 / 255, blue: 1)
    static let dim = Color(red: 157 / 255, green: 143 / 255, blue: 196 / 255)
    static let live = Color(red: 1, green: 59 / 255, blue: 92 / 255)
}

// MARK: - Data

struct WidgetSummary: Decodable {
    var live: [LiveItem]
    var movies: [MovieItem]
    var resume: [MovieItem]? = nil   // "continue": films you're partway through

    enum CodingKeys: String, CodingKey { case live, movies, resume = "continue" }

    /// What the Movies widget shows: Continue watching first, then the newest films.
    var movieList: [MovieItem] {
        var seen = Set<String>()
        return ((resume ?? []) + movies).filter { seen.insert($0.title).inserted }
    }
}

struct LiveItem: Decodable, Identifiable {
    var key: String
    var kind: String
    var title: String
    var subtitle: String
    var count: Int?
    var progress: Double?
    var progressLabel: String?
    var paused: Bool?
    var url: String
    var started: Double?
    var id: String { key }
}

struct MovieItem: Decodable, Identifiable {
    var title: String
    var year: String?
    var poster: String?
    var imdb: String?
    var url: String
    var progress: Double? = nil   // Continue watching: how far you got
    var left: String? = nil       // "75 min left"
    var id: String { (imdb ?? "") + title }
}

/// What a widget shows: the summary, the posters already downloaded (a widget can't load
/// images itself), or why there's nothing. The Slap widget: what's playing and its cover.
struct WidgetData {
    var summary: WidgetSummary?
    var posters: [String: Data] = [:]
    var signedOut = false
    var slap: SlapNow? = nil
    var slapArt: Data? = nil
}

// MARK: - The Live Activity (lock screen and banner)

struct LiveCard: View {
    let kind: String
    let state: CRCMZLiveAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(LiveKind.emoji(kind)).font(.title3)
                VStack(alignment: .leading, spacing: 1) {
                    Text(LiveKind.label(kind).uppercased())
                        .font(.caption2.weight(.heavy)).tracking(1.2).foregroundStyle(Brand.cyan)
                    Text(state.title).font(.headline).foregroundStyle(Brand.text).lineLimit(1)
                }
                Spacer(minLength: 4)
                LiveBadge(paused: state.paused)
            }
            Text(state.subtitle).font(.subheadline).foregroundStyle(Brand.dim).lineLimit(1)
            if state.progress >= 0 {
                ProgressView(value: min(1, max(0, state.progress)))
                    .tint(Brand.magenta)
                HStack {
                    Text(state.progressLabel).font(.caption.monospacedDigit()).foregroundStyle(Brand.dim)
                    Spacer()
                    Elapsed(started: state.started).font(.caption.monospacedDigit()).foregroundStyle(Brand.dim)
                }
            } else {
                HStack(spacing: 4) {
                    Image(systemName: "clock").font(.caption)
                    Elapsed(started: state.started)
                }
                .font(.caption.monospacedDigit()).foregroundStyle(Brand.dim)
            }
        }
        .padding(14)
    }
}

/// Counts up from when it began, by itself (the system ticks it; no updates needed).
struct Elapsed: View {
    let started: Double
    var body: some View {
        Text(timerInterval: Date(timeIntervalSince1970: started)...Date.distantFuture, countsDown: false)
            .monospacedDigit()
    }
}

struct LiveBadge: View {
    let paused: Bool
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(paused ? Brand.dim : Brand.live).frame(width: 7, height: 7)
            Text(paused ? "PAUSED" : "LIVE").font(.caption2.weight(.heavy))
        }
        .foregroundStyle(paused ? Brand.dim : Brand.text)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Capsule().fill(Color.white.opacity(0.08)))
    }
}

// MARK: - Live now

struct LiveNowView: View {
    let data: WidgetData
    let large: Bool   // medium: up to three rows; small: the first one

    var body: some View {
        if data.signedOut {
            SignedOut()
        } else if let items = data.summary?.live, !items.isEmpty {
            if large {
                VStack(alignment: .leading, spacing: 8) {
                    Header(text: "Live now", count: items.count)
                    ForEach(items.prefix(3)) { it in
                        Link(destination: AppLink.url(it.url)) { LiveRow(item: it) }
                    }
                    Spacer(minLength: 0)
                }
            } else {
                let it = items[0]
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(LiveKind.emoji(it.kind)).font(.title2)
                        Spacer()
                        LiveBadge(paused: it.paused ?? false)
                    }
                    Spacer(minLength: 0)
                    Text(LiveKind.label(it.kind).uppercased()).font(.caption2.weight(.heavy)).foregroundStyle(Brand.cyan)
                    Text(it.title).font(.headline).foregroundStyle(Brand.text).lineLimit(2)
                    Text(it.subtitle).font(.caption).foregroundStyle(Brand.dim).lineLimit(2)
                    if items.count > 1 {
                        Text("+\(items.count - 1) more live").font(.caption2.weight(.bold)).foregroundStyle(Brand.magenta)
                    }
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Header(text: "Live now", count: 0)
                Spacer(minLength: 0)
                Text("Nothing live").font(.headline).foregroundStyle(Brand.text)
                Text(large ? "Start a Watch Party or a Huddle and the squad sees it here." : "Start a party")
                    .font(.caption).foregroundStyle(Brand.dim).lineLimit(2)
            }
        }
    }
}

struct LiveRow: View {
    let item: LiveItem
    var body: some View {
        HStack(spacing: 10) {
            Text(LiveKind.emoji(item.kind)).font(.title3)
                .frame(width: 34, height: 34).background(RoundedRectangle(cornerRadius: 9).fill(Color.white.opacity(0.07)))
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.text).lineLimit(1)
                Text(item.subtitle).font(.caption).foregroundStyle(Brand.dim).lineLimit(1)
            }
            Spacer(minLength: 4)
            if let p = item.progress, p >= 0 {
                ProgressView(value: min(1, max(0, p))).tint(Brand.magenta).frame(width: 44)
            }
        }
    }
}

// MARK: - Movies: Continue watching, then the newest

struct NewMoviesView: View {
    let data: WidgetData
    let rows: Int   // medium: one row of four; large: two

    var body: some View {
        if data.signedOut {
            SignedOut()
        } else {
            let movies = Array((data.summary?.movieList ?? []).prefix(rows * 4))
            let resuming = !(data.summary?.resume ?? []).isEmpty
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Header(text: resuming ? "Continue watching" : "New in the library", count: 0)
                    Spacer()
                    Link(destination: AppLink.url("/app/watch?add=1")) {
                        Image(systemName: "plus.circle.fill").font(.title3).foregroundStyle(Brand.magenta)
                    }
                }
                if movies.isEmpty {
                    Spacer(minLength: 0)
                    Text("No movies yet. Tap + to add one.").font(.caption).foregroundStyle(Brand.dim)
                    Spacer(minLength: 0)
                } else {
                    ForEach(0..<rows, id: \.self) { r in
                        HStack(spacing: 8) {
                            ForEach(Array(movies.dropFirst(r * 4).prefix(4))) { m in
                                Link(destination: AppLink.url(m.url)) { PosterTile(movie: m, image: data.posters[m.id]) }
                            }
                            ForEach(0..<max(0, 4 - movies.dropFirst(r * 4).prefix(4).count), id: \.self) { _ in Color.clear.frame(maxWidth: .infinity) }
                        }
                    }
                }
            }
        }
    }
}

struct PosterTile: View {
    let movie: MovieItem
    let image: Data?
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Group {
                if let image, let ui = UIImage(data: image) {
                    Image(uiImage: ui).resizable().aspectRatio(contentMode: .fill)
                } else {
                    ZStack {
                        Brand.panel
                        Text(movie.title).font(.caption2.weight(.bold)).foregroundStyle(Brand.dim).multilineTextAlignment(.center).padding(4)
                    }
                }
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(2 / 3, contentMode: .fit)
            .overlay(alignment: .bottom) {
                if let p = movie.progress, p > 0 {
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Rectangle().fill(Color.black.opacity(0.55))
                            Rectangle().fill(Brand.magenta).frame(width: g.size.width * min(1, p))
                        }
                    }
                    .frame(height: 3)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 7))
            Text(movie.left ?? movie.title).font(.caption2.weight(.semibold)).foregroundStyle(Brand.text).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)   // four equal tiles, whatever the titles
    }
}

// MARK: - Slap: what's playing

struct SlapView: View {
    let data: WidgetData
    let small: Bool

    var body: some View {
        let now = data.slap
        let loaded = now?.loaded ?? false
        let playing = now?.playing ?? false
        if small {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .top) {
                    Cover(art: data.slapArt, size: 46)
                    Spacer(minLength: 0)
                    PlayButton(loaded: loaded, playing: playing, size: 34)
                }
                Spacer(minLength: 4)
                Text(heading(now)).font(.caption2.weight(.heavy)).tracking(1.1).foregroundStyle(Brand.cyan)
                Text(now?.title ?? "Shuffle the library").font(.subheadline.weight(.bold)).foregroundStyle(Brand.text).lineLimit(1)
                Text(now?.artist ?? "Slap").font(.caption).foregroundStyle(Brand.dim).lineLimit(1)
            }
        } else {
            HStack(spacing: 14) {
                Cover(art: data.slapArt, size: 92)
                VStack(alignment: .leading, spacing: 2) {
                    Text(heading(now)).font(.caption2.weight(.heavy)).tracking(1.1).foregroundStyle(Brand.cyan)
                    Text(now?.title ?? "Shuffle the library").font(.headline).foregroundStyle(Brand.text).lineLimit(1)
                    Text(now?.artist ?? "Tap play to start Slap").font(.caption).foregroundStyle(Brand.dim).lineLimit(1)
                    Spacer(minLength: 4)
                    HStack(spacing: 18) {
                        if loaded { Control(action: "prev", symbol: "backward.fill") }
                        PlayButton(loaded: loaded, playing: playing, size: 40)
                        if loaded { Control(action: "next", symbol: "forward.fill") }
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }

    private func heading(_ now: SlapNow?) -> String {
        guard let now else { return "SLAP" }
        return now.loaded ? (now.playing ? "NOW PLAYING" : "PAUSED") : "LAST PLAYED"
    }
}

private struct Cover: View {
    let art: Data?
    let size: CGFloat
    var body: some View {
        Group {
            if let art, let ui = UIImage(data: art) {
                Image(uiImage: ui).resizable().aspectRatio(contentMode: .fill)
            } else {
                ZStack { Brand.panel; Image(systemName: "music.note").font(.title2).foregroundStyle(Brand.magenta) }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

/// Play / pause. Something loaded: it drives the app's player in place (iOS 17+). Nothing
/// loaded: starting music needs the page (it keeps the queue), so it opens Slap to carry on.
private struct PlayButton: View {
    let loaded: Bool
    let playing: Bool
    let size: CGFloat
    var body: some View {
        let face = Image(systemName: playing ? "pause.fill" : "play.fill")
            .font(.system(size: size * 0.4, weight: .bold)).foregroundStyle(.white)
            .frame(width: size, height: size).background(Circle().fill(Brand.magenta))
        if loaded, #available(iOS 17.0, *) {
            Button(intent: SlapControlIntent("toggle")) { face }.buttonStyle(.plain)
        } else {
            Link(destination: AppLink.url(loaded ? "/app/slap" : "/app/slap?play=1")) { face }
        }
    }
}

private struct Control: View {
    let action: String
    let symbol: String
    var body: some View {
        let face = Image(systemName: symbol).font(.system(size: 17, weight: .bold)).foregroundStyle(Brand.text)
        if #available(iOS 17.0, *) {
            Button(intent: SlapControlIntent(action)) { face }.buttonStyle(.plain)
        } else {
            Link(destination: AppLink.url("/app/slap")) { face }
        }
    }
}

// MARK: - Live now on the lock screen

struct LiveNowAccessory: View {
    let data: WidgetData
    var body: some View {
        if let it = data.summary?.live.first {
            VStack(alignment: .leading, spacing: 1) {
                Text("\(LiveKind.emoji(it.kind)) \(LiveKind.label(it.kind))").font(.caption2.weight(.bold))
                Text(it.title).font(.headline).lineLimit(1)
                Text(it.subtitle).font(.caption2).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            VStack(alignment: .leading, spacing: 1) {
                Text("CRCMZ").font(.caption2.weight(.bold))
                Text(data.signedOut ? "Open CRCMZ to sign in" : "Nothing live").font(.headline).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - Bits

struct Header: View {
    let text: String
    let count: Int
    var body: some View {
        HStack(spacing: 6) {
            Text(text.uppercased()).font(.caption2.weight(.heavy)).tracking(1.1).foregroundStyle(Brand.cyan)
            if count > 0 { Circle().fill(Brand.live).frame(width: 6, height: 6) }
        }
    }
}

struct SignedOut: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("CRCMZ").font(.headline.weight(.heavy)).foregroundStyle(Brand.magenta)
            Spacer(minLength: 0)
            Text("Open CRCMZ to sign in").font(.subheadline.weight(.semibold)).foregroundStyle(Brand.text)
            Text("Then this shows what the squad is up to.").font(.caption).foregroundStyle(Brand.dim)
        }
    }
}
