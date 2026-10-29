import ActivityKit
import SwiftUI
import UIKit

/// Live Activities (live.py on the server): a Watch Party, Huddle, Listen Together or
/// tournament on the lock screen and in the Dynamic Island. The server starts them by
/// push (push-to-start, iOS 17.2+) for whoever switched them on in Settings, and keeps
/// them up to date with each activity's own token. This hands both kinds of token to
/// the server (POST /api/live/ios) as you, with the session the share extension uses
/// (SharedSession); tokens that couldn't go yet (signed out) go after the next page load.
enum LiveActivities {
    private static var tracked = Set<String>()
    private static var pending: [[String: Any]] = []
    private static let queue = DispatchQueue(label: "crcmz.live")

    static func start() {
        guard #available(iOS 16.2, *) else { return }
        #if DEBUG
        // -crcmzLiveDemo <playing|paused|stale|ended|two>: sample activities started here (a
        // simulator can't get the push). Nothing is sent to the server.
        if let i = ProcessInfo.processInfo.arguments.firstIndex(of: "-crcmzLiveDemo") {
            let args = ProcessInfo.processInfo.arguments
            demo(i + 1 < args.count ? args[i + 1] : "playing")
            return
        }
        #endif
        if #available(iOS 17.2, *) {
            Task {
                for await data in Activity<CRCMZLiveAttributes>.pushToStartTokenUpdates {
                    let token = hex(data)
                    UserDefaults.standard.set(token, forKey: startKey)
                    post(["start": token, "enabled": ActivityAuthorizationInfo().areActivitiesEnabled])
                }
            }
        }
        // Live Activities on or off for the app (Settings › CRCMZ): off, the server sends an
        // ordinary notification instead of starting one. Told now and on every change.
        let info = ActivityAuthorizationInfo()
        post(enabledBody(info.areActivitiesEnabled))
        Task {
            for await on in info.activityEnablementUpdates { post(enabledBody(on)) }
        }
        Task {
            for await activity in Activity<CRCMZLiveAttributes>.activityUpdates { track(activity) }
        }
        for a in Activity<CRCMZLiveAttributes>.activities { track(a) }
    }

    /// After a page load (a sign-in, say): send anything that waited for the session.
    static func flush() {
        queue.async {
            let waiting = pending
            pending = []
            for body in waiting { post(body) }
        }
    }

    @available(iOS 16.2, *)
    private static func track(_ a: Activity<CRCMZLiveAttributes>) {
        guard queue.sync(execute: { tracked.insert(a.id).inserted }) else { return }
        let key = a.attributes.key
        Task {
            for await t in a.pushTokenUpdates { post(["key": key, "token": hex(t)]) }
        }
        // The film's poster: kept where the activity's view can read it, then redrawn with it.
        Task {
            await poster(a, a.content.state)
            for await c in a.contentUpdates { await poster(a, c.state) }
        }
        Task {
            for await st in a.activityStateUpdates where st == .ended || st == .dismissed {
                // Swiped away: like Hide, so a push doesn't bring it back this session.
                let session = a.content.state.session ?? ""
                if let t = a.pushToken {
                    post(["key": key, "token": hex(t), "ended": true, "dismissed": st == .dismissed, "session": session])
                } else if st == .dismissed, !session.isEmpty {
                    post(["hide": session])
                }
                break
            }
        }
    }

    @available(iOS 16.2, *)
    private static func poster(_ a: Activity<CRCMZLiveAttributes>, _ state: CRCMZLiveAttributes.ContentState) async {
        guard let url = state.poster, !url.isEmpty, LivePoster.image(for: url) == nil else { return }
        await LivePoster.cache(url)
        guard LivePoster.image(for: url) != nil, a.activityState == .active else { return }
        await a.update(a.content)
    }

    private static func post(_ body: [String: Any]) {
        guard let session = SharedSession.read() else {
            queue.async { pending.append(body) }
            return
        }
        var rq = URLRequest(url: URL(string: "https://app.crcmz.me/api/live/ios")!)
        rq.httpMethod = "POST"
        rq.timeoutInterval = 20
        rq.setValue("https://app.crcmz.me", forHTTPHeaderField: "Origin")
        rq.setValue("psn_session=\(session)", forHTTPHeaderField: "Cookie")
        rq.setValue("application/json", forHTTPHeaderField: "Content-Type")
        rq.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: rq) { _, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if err != nil || code == 401 || code >= 500 { queue.async { pending.append(body) } }
        }.resume()
    }

    private static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

    private static let startKey = "crcmz.live.startToken"

    private static func enabledBody(_ on: Bool) -> [String: Any] {
        var b: [String: Any] = ["enabled": on]
        if let t = UserDefaults.standard.string(forKey: startKey) { b["start"] = t }
        return b
    }

    #if DEBUG
    private static func demo(_ which: String) {
        guard #available(iOS 16.2, *) else { return }
        Task {
            for a in Activity<CRCMZLiveAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) }
            await LivePoster.cache(LiveSample.poster)
            let state = LiveSample.state(which == "two" ? "playing" : which)
            _ = try? Activity.request(attributes: CRCMZLiveAttributes(key: "watch:crcmz", kind: "watch"),
                                      content: .init(state: state, staleDate: which == "stale" ? Date() : nil), pushType: nil)
            if which == "two" {
                // A second activity: the island shows one compact and one minimal.
                let huddle = CRCMZLiveAttributes.ContentState(
                    title: "Huddle", subtitle: "2 in the call · Samad, Noor", count: 2, names: ["Samad", "Noor"],
                    started: Date().timeIntervalSince1970 - 600, progress: -1, progressLabel: "", paused: false, url: "/app/huddle")
                _ = try? Activity.request(attributes: CRCMZLiveAttributes(key: "huddle:crcmz", kind: "huddle"),
                                          content: .init(state: huddle, staleDate: nil), pushType: nil)
            }
        }
    }
    #endif
}

#if DEBUG
/// -crcmzWidgetDemo: the widgets' views laid out at their real sizes, for a screenshot
/// (a simulator can't put a widget on the home screen from the command line).
struct WidgetGallery: View {
    let data = WidgetData(summary: WidgetSummary(
        live: [
            LiveItem(key: "watch:crcmz", kind: "watch", title: "Dune: Part Two", subtitle: "4 watching · moiz, Moose, Noor +1",
                     count: 4, progress: 0.42, progressLabel: "70 of 166 min", paused: false, url: "/app/watch/party", started: nil),
            LiveItem(key: "huddle:crcmz", kind: "huddle", title: "Huddle", subtitle: "3 in the call · Samad, Moose, Noor",
                     count: 3, progress: -1, progressLabel: "", paused: false, url: "/app/huddle", started: nil),
            LiveItem(key: "tourney:1", kind: "tourney", title: "FC 27 Cup", subtitle: "8 players · 5 of 12 matches played",
                     count: 8, progress: 0.42, progressLabel: "Match 6 of 12", paused: false, url: "/app/tourney/1", started: nil),
        ],
        movies: [MovieItem(title: "Dune: Part Two", year: "2024", poster: nil, imdb: "a", url: "/app/watch"),
                 MovieItem(title: "Interstellar", year: "2014", poster: nil, imdb: "b", url: "/app/watch"),
                 MovieItem(title: "The Dark Knight", year: "2008", poster: nil, imdb: "c", url: "/app/watch"),
                 MovieItem(title: "The Matrix", year: "1999", poster: nil, imdb: "d", url: "/app/watch")],
        resume: [MovieItem(title: "Oppenheimer", year: "2023", poster: nil, imdb: "e", url: "/app/watch", progress: 0.35, left: "117 min left")]))
    let playing = WidgetData(slap: SlapNow(title: "Digits", artist: "Young Thug", art: "", playing: true, loaded: true))
    let idle = WidgetData(slap: SlapNow(title: "Money Trees", artist: "Kendrick Lamar", art: "", playing: false, loaded: false))
    let state = CRCMZLiveAttributes.ContentState(
        title: "Dune: Part Two", subtitle: "4 watching · moiz, Moose, Noor +1", count: 4, names: ["moiz", "Moose", "Noor", "Samad"],
        started: Date().timeIntervalSince1970 - 4200, progress: 0.42, progressLabel: "70 of 166 min", paused: false, url: "/app/watch/party",
        elapsed: 4200, duration: 9960, at: Date().timeIntervalSince1970)

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                tile(SlapView(data: playing, small: false), w: 338, h: 158)
                tile(SlapView(data: idle, small: false), w: 338, h: 158)
                LiveCard(kind: "watch", key: "watch:crcmz", state: state).background(LivePalette.background).clipShape(RoundedRectangle(cornerRadius: 22))
                HStack(spacing: 16) {
                    tile(LiveNowView(data: data, large: false), w: 158, h: 158)
                    tile(SlapView(data: playing, small: true), w: 158, h: 158)
                }
                tile(LiveNowView(data: data, large: true), w: 338, h: 158)
                tile(NewMoviesView(data: data, rows: 1), w: 338, h: 158)
                tile(LiveNowAccessory(data: data).foregroundStyle(.white), w: 170, h: 72)
                tile(LiveNowView(data: WidgetData(signedOut: true), large: false), w: 158, h: 158)
            }
            .padding()
        }
        .background(Color(white: 0.2))
    }

    private func tile<V: View>(_ v: V, w: CGFloat, h: CGFloat) -> some View {
        v.padding(14).frame(width: w, height: h, alignment: .topLeading).background(Brand.ink).clipShape(RoundedRectangle(cornerRadius: 22))
    }
}
#endif
