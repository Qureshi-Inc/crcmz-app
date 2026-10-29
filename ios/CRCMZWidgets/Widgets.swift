import ActivityKit
import SwiftUI
import WidgetKit

/// CRCMZ's widgets and its Live Activity. The views are in ios/Shared (WidgetViews.swift);
/// this target wires them to WidgetKit and ActivityKit. Data: GET /api/widgets/summary as
/// you (the app's session, SharedSession, the keychain group the share extension uses too).
@main
struct CRCMZWidgets: WidgetBundle {
    var body: some Widget {
        LiveNowWidget()
        NewMoviesWidget()
        SlapWidget()
        CRCMZLiveActivity()
    }
}

// MARK: - The Live Activity: lock screen, banner, Dynamic Island

/// A Watch Party draws WatchLive.swift's views (light or dark on the lock screen); the
/// other kinds keep their dark card.
struct CRCMZLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CRCMZLiveAttributes.self) { ctx in
            let watch = ctx.attributes.kind == "watch"
            LiveCard(kind: ctx.attributes.kind, key: ctx.attributes.key, state: ctx.state, stale: ctx.isStale)
                .activityBackgroundTint(watch ? LivePalette.background : Brand.ink)
                .activitySystemActionForegroundColor(watch ? LivePalette.text : Brand.text)
                .widgetURL(AppLink.url(ctx.state.url))
        } dynamicIsland: { ctx in
            let party = PartyNow(ctx.state, key: ctx.attributes.key, stale: ctx.isStale)
            let watch = ctx.attributes.kind == "watch"
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    if watch {
                        WatchIslandLeading(party: party)
                    } else {
                        HStack(spacing: 6) {
                            Text(LiveKind.emoji(ctx.attributes.kind)).font(.title3)
                            if ctx.state.count > 0 {
                                Label("\(ctx.state.count)", systemImage: "person.2.fill").font(.caption.weight(.bold)).foregroundStyle(Brand.cyan)
                            }
                        }
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if watch {
                        WatchIslandTrailing(party: party)
                    } else if ctx.state.paused {
                        Text("Paused").font(.caption.weight(.bold)).foregroundStyle(Brand.dim)
                    } else {
                        Elapsed(started: ctx.state.started).font(.caption.weight(.semibold)).foregroundStyle(Brand.text)
                            .frame(maxWidth: 64, alignment: .trailing)
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    if watch {
                        WatchIslandCenter(party: party)
                    } else {
                        Text(ctx.state.title).font(.headline).foregroundStyle(Brand.text).lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if watch {
                        WatchIslandBottom(party: party)
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(ctx.state.subtitle).font(.caption).foregroundStyle(Brand.dim).lineLimit(1)
                            if ctx.state.progress >= 0 {
                                ProgressView(value: min(1, max(0, ctx.state.progress))).tint(Brand.magenta)
                                if !ctx.state.progressLabel.isEmpty {
                                    Text(ctx.state.progressLabel).font(.caption2.monospacedDigit()).foregroundStyle(Brand.dim)
                                }
                            }
                        }
                    }
                }
            } compactLeading: {
                if watch { WatchCompactLeading(party: party) } else { Text(LiveKind.emoji(ctx.attributes.kind)) }
            } compactTrailing: {
                if watch {
                    WatchCompactTrailing(party: party)
                } else if ctx.state.progress >= 0 {
                    ProgressView(value: min(1, max(0, ctx.state.progress)))
                        .progressViewStyle(.circular).tint(Brand.magenta).frame(width: 20, height: 20)
                } else {
                    Text("\(ctx.state.count)").font(.caption.weight(.bold)).foregroundStyle(Brand.cyan)
                }
            } minimal: {
                if watch { WatchMinimal(party: party) } else { Text(LiveKind.emoji(ctx.attributes.kind)) }
            }
            .widgetURL(AppLink.url(ctx.state.url))
            .keylineTint(watch ? LivePalette.accent : Brand.magenta)
        }
    }
}

// MARK: - Home screen widgets

struct SummaryEntry: TimelineEntry {
    let date: Date
    let data: WidgetData
}

struct SummaryProvider: TimelineProvider {
    var posters = false

    func placeholder(in context: Context) -> SummaryEntry { SummaryEntry(date: .now, data: Sample.data) }

    func getSnapshot(in context: Context, completion: @escaping (SummaryEntry) -> Void) {
        if context.isPreview { completion(SummaryEntry(date: .now, data: Sample.data)); return }
        Task { completion(SummaryEntry(date: .now, data: await Fetch.summary(posters: posters))) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SummaryEntry>) -> Void) {
        Task {
            let data = await Fetch.summary(posters: posters)
            // Live things change faster than the library: a little more often while something's on.
            let live = !(data.summary?.live.isEmpty ?? true)
            completion(Timeline(entries: [SummaryEntry(date: .now, data: data)],
                                policy: .after(.now.addingTimeInterval(live ? 10 * 60 : 20 * 60))))
        }
    }
}

struct LiveNowWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "me.crcmz.live-now", provider: SummaryProvider()) { e in
            LiveNowWidgetView(entry: e)
        }
        .configurationDisplayName("Live now")
        .description("A Watch Party, Huddle, Listen Together or tournament going on right now.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

struct LiveNowWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: SummaryEntry
    var body: some View {
        Group {
            if family == .accessoryRectangular { LiveNowAccessory(data: entry.data) }
            else { LiveNowView(data: entry.data, large: family != .systemSmall) }
        }
        .widgetURL(AppLink.url(entry.data.summary?.live.first?.url ?? "/app/watch"))
        .brandBackground(accessory: family == .accessoryRectangular)
    }
}

struct NewMoviesWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "me.crcmz.new-movies", provider: SummaryProvider(posters: true)) { e in
            NewMoviesWidgetView(entry: e)
        }
        .configurationDisplayName("Movies")
        .description("Pick up where you left off, and the newest movies in the squad's library.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

struct NewMoviesWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: SummaryEntry
    var body: some View {
        NewMoviesView(data: entry.data, rows: family == .systemLarge ? 2 : 1)
            .widgetURL(AppLink.url("/app/watch"))
            .brandBackground()
    }
}

struct SlapEntry: TimelineEntry {
    let date: Date
    let data: WidgetData
}

/// The Slap widget's data comes from the app (SlapNow, written on every change, which also
/// reloads this); only the cover is fetched here, as you.
struct SlapProvider: TimelineProvider {
    func placeholder(in context: Context) -> SlapEntry {
        SlapEntry(date: .now, data: WidgetData(slap: SlapNow(title: "Digits", artist: "Young Thug", art: "", playing: true, loaded: true)))
    }
    func getSnapshot(in context: Context, completion: @escaping (SlapEntry) -> Void) {
        if context.isPreview { completion(placeholder(in: context)); return }
        Task { completion(await entry()) }
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<SlapEntry>) -> Void) {
        Task { completion(Timeline(entries: [await entry()], policy: .never)) }
    }
    private func entry() async -> SlapEntry {
        let now = SlapNow.read()
        return SlapEntry(date: .now, data: WidgetData(slap: now, slapArt: await Fetch.cover(now?.art ?? "")))
    }
}

struct SlapWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: SlapNow.widgetKind, provider: SlapProvider()) { e in
            SlapWidgetView(entry: e)
        }
        .configurationDisplayName("Slap")
        .description("What's playing, with play, pause and skip. Nothing on? Tap play to carry on.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct SlapWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: SlapEntry
    var body: some View {
        SlapView(data: entry.data, small: family == .systemSmall)
            .widgetURL(AppLink.url("/app/slap"))
            .brandBackground()
    }
}

extension View {
    /// The dark CRCMZ background: containerBackground on iOS 17+ (required there), plain
    /// background on 16. Lock-screen accessories keep the system's.
    @ViewBuilder func brandBackground(accessory: Bool = false) -> some View {
        if accessory {
            if #available(iOS 17.0, *) { containerBackground(.clear, for: .widget) } else { self }
        } else if #available(iOS 17.0, *) {
            containerBackground(for: .widget) { Brand.ink }
        } else {
            padding().background(Brand.ink)
        }
    }
}

// MARK: - The server

enum Fetch {
    static let base = URL(string: "https://app.crcmz.me")!

    static func summary(posters: Bool) async -> WidgetData {
        guard let session = SharedSession.read() else { return WidgetData(signedOut: true) }
        var rq = URLRequest(url: base.appendingPathComponent("api/widgets/summary"))
        rq.timeoutInterval = 15
        rq.setValue("psn_session=\(session)", forHTTPHeaderField: "Cookie")
        guard let (body, resp) = try? await URLSession.shared.data(for: rq) else { return WidgetData() }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 { return WidgetData(signedOut: true) }
        guard code == 200, let s = try? JSONDecoder().decode(WidgetSummary.self, from: body) else { return WidgetData() }
        // A Watch Party's poster, kept for its Live Activity (which can't load it itself).
        await LivePoster.cache(s.live.first(where: { $0.kind == "watch" })?.poster)
        var out = WidgetData(summary: s)
        if posters { out.posters = await thumbs(Array(s.movieList.prefix(8))) }
        return out
    }

    /// Slap's cover, small. It's on app.crcmz.me behind the sign-in, so it goes as you.
    static func cover(_ s: String) async -> Data? {
        guard let u = URL(string: s), u.host == base.host, let session = SharedSession.read() else { return nil }
        var rq = URLRequest(url: u)
        rq.timeoutInterval = 10
        rq.setValue("psn_session=\(session)", forHTTPHeaderField: "Cookie")
        guard let (d, _) = try? await URLSession.shared.data(for: rq), let img = UIImage(data: d) else { return nil }
        let size = CGSize(width: 240, height: 240 * img.size.height / max(1, img.size.width))
        return UIGraphicsImageRenderer(size: size).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }.jpegData(compressionQuality: 0.8)
    }

    /// Posters, small: a widget has a few MB of memory, and full posters would blow it.
    private static func thumbs(_ movies: [MovieItem]) async -> [String: Data] {
        await withTaskGroup(of: (String, Data?).self) { g in
            for m in movies {
                guard let s = m.poster, let u = URL(string: s.replacingOccurrences(of: "/poster/medium/", with: "/poster/small/")) else { continue }
                g.addTask {
                    guard let (d, _) = try? await URLSession.shared.data(from: u), let img = UIImage(data: d) else { return (m.id, nil) }
                    let w: CGFloat = 180
                    let size = CGSize(width: w, height: w * img.size.height / max(1, img.size.width))
                    let small = UIGraphicsImageRenderer(size: size).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
                    return (m.id, small.jpegData(compressionQuality: 0.8))
                }
            }
            var out: [String: Data] = [:]
            for await (id, d) in g { if let d { out[id] = d } }
            return out
        }
    }
}

enum Sample {
    static let data = WidgetData(summary: WidgetSummary(
        live: [LiveItem(key: "watch:crcmz", kind: "watch", title: "Dune: Part Two", subtitle: "4 watching · moiz, Moose, Noor +1",
                        count: 4, progress: 0.42, progressLabel: "70 of 166 min", paused: false, url: "/app/watch/party", started: Date().timeIntervalSince1970 - 4200)],
        movies: []))
}
