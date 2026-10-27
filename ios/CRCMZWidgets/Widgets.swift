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
        AddMovieWidget()
        CRCMZLiveActivity()
    }
}

// MARK: - The Live Activity: lock screen, banner, Dynamic Island

struct CRCMZLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CRCMZLiveAttributes.self) { ctx in
            LiveCard(kind: ctx.attributes.kind, state: ctx.state)
                .activityBackgroundTint(Brand.ink)
                .activitySystemActionForegroundColor(Brand.text)
                .widgetURL(AppLink.url(ctx.state.url))
        } dynamicIsland: { ctx in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        Text(LiveKind.emoji(ctx.attributes.kind)).font(.title3)
                        if ctx.state.count > 0 {
                            Label("\(ctx.state.count)", systemImage: "person.2.fill").font(.caption.weight(.bold)).foregroundStyle(Brand.cyan)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if ctx.state.paused {
                        Text("Paused").font(.caption.weight(.bold)).foregroundStyle(Brand.dim)
                    } else {
                        Elapsed(started: ctx.state.started).font(.caption.weight(.semibold)).foregroundStyle(Brand.text)
                            .frame(maxWidth: 64, alignment: .trailing)
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(ctx.state.title).font(.headline).foregroundStyle(Brand.text).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
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
            } compactLeading: {
                Text(LiveKind.emoji(ctx.attributes.kind))
            } compactTrailing: {
                if ctx.state.progress >= 0 {
                    ProgressView(value: min(1, max(0, ctx.state.progress)))
                        .progressViewStyle(.circular).tint(Brand.magenta).frame(width: 20, height: 20)
                } else {
                    Text("\(ctx.state.count)").font(.caption.weight(.bold)).foregroundStyle(Brand.cyan)
                }
            } minimal: {
                Text(LiveKind.emoji(ctx.attributes.kind))
            }
            .widgetURL(AppLink.url(ctx.state.url))
            .keylineTint(Brand.magenta)
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
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct LiveNowWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: SummaryEntry
    var body: some View {
        LiveNowView(data: entry.data, large: family != .systemSmall)
            .widgetURL(AppLink.url(entry.data.summary?.live.first?.url ?? "/app/watch"))
            .brandBackground()
    }
}

struct NewMoviesWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "me.crcmz.new-movies", provider: SummaryProvider(posters: true)) { e in
            NewMoviesWidgetView(entry: e)
        }
        .configurationDisplayName("New in the library")
        .description("The newest movies in the squad's library. Tap one to watch it together.")
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

struct AddMovieWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "me.crcmz.add-movie", provider: StaticProvider()) { _ in
            AddMovieWidgetView()
        }
        .configurationDisplayName("Add a movie")
        .description("Jump straight into the movie search.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular])
    }
}

struct AddMovieWidgetView: View {
    @Environment(\.widgetFamily) var family
    var body: some View {
        Group {
            switch family {
            case .accessoryCircular:
                ZStack {
                    AccessoryWidgetBackground()
                    Image(systemName: "film.stack").font(.title3)
                }
            case .accessoryRectangular:
                HStack(spacing: 6) {
                    Image(systemName: "plus.circle.fill")
                    VStack(alignment: .leading) {
                        Text("Add a movie").font(.headline)
                        Text("CRCMZ library").font(.caption)
                    }
                }
            default:
                AddMovieView()
            }
        }
        .widgetURL(AppLink.url("/app/watch?add=1"))
        .brandBackground(accessory: family == .accessoryCircular || family == .accessoryRectangular)
    }
}

struct StaticEntry: TimelineEntry { let date: Date }
struct StaticProvider: TimelineProvider {
    func placeholder(in context: Context) -> StaticEntry { StaticEntry(date: .now) }
    func getSnapshot(in context: Context, completion: @escaping (StaticEntry) -> Void) { completion(StaticEntry(date: .now)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<StaticEntry>) -> Void) {
        completion(Timeline(entries: [StaticEntry(date: .now)], policy: .never))
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
        var out = WidgetData(summary: s)
        if posters { out.posters = await thumbs(Array(s.movies.prefix(8))) }
        return out
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
