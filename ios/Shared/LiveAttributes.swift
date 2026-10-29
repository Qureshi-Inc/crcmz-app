import ActivityKit
import Foundation

/// A Live Activity: something the squad is doing right now (live.py on the server).
/// The server starts, updates and ends these by push; the type name and every field below
/// are its contract (live.ATTRIBUTES_TYPE and live._state()), so don't rename them.
struct CRCMZLiveAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var title: String
        var subtitle: String
        var count: Int
        var names: [String]
        /// When it began (unix seconds): the timer counts up from here.
        var started: Double
        /// 0…1, or -1 when there's nothing to measure (a Huddle).
        var progress: Double
        var progressLabel: String
        var paused: Bool
        /// The page it opens, e.g. /app/watch/party.
        var url: String
        /// A Watch Party's film, in seconds, as of `at` (unix seconds): the clock and bar run
        /// from these by themselves. Optional: older servers don't send them.
        var elapsed: Double? = nil
        var duration: Double? = nil
        var at: Double? = nil
        /// The film's poster (a signed link). The app keeps a small copy (LivePoster).
        var poster: String? = nil
        /// Build 20+: the rest of the shared state (live.py _state). One party is one
        /// `session` (key@start); `status` is playing | paused | stale | ended; the film runs at
        /// `rate`; a bigger `rev` is newer; `people` is "Moiz, Noor +1"; `joined`: you're in it
        /// ("Open party"); `private`: no film or names (the server already left them out).
        var session: String? = nil
        var status: String? = nil
        var rate: Double? = nil
        var rev: Int? = nil
        var people: String? = nil
        var joined: Bool? = nil
        var `private`: Bool? = nil
    }

    /// watch:<room>, huddle:<room>, slap:together, tourney:<id>
    var key: String
    /// watch | huddle | slap | tourney
    var kind: String
}

enum LiveKind {
    static func emoji(_ kind: String) -> String {
        switch kind {
        case "watch": return "📺"
        case "huddle": return "🎧"
        case "slap": return "🎵"
        case "tourney": return "🏆"
        default: return "✨"
        }
    }
    static func label(_ kind: String) -> String {
        switch kind {
        case "watch": return "Watch Party"
        case "huddle": return "Huddle"
        case "slap": return "Listen Together"
        case "tourney": return "Tournament"
        default: return "Live"
        }
    }
}

/// Opening the app on a page from a widget or a Live Activity: crcmz://open?path=/app/…
/// (AppDelegate hands it to the web view).
enum AppLink {
    static func url(_ path: String) -> URL {
        var c = URLComponents()
        c.scheme = "crcmz"
        c.host = "open"
        c.queryItems = [URLQueryItem(name: "path", value: path.hasPrefix("/app") ? path : "/app")]
        return c.url ?? URL(string: "crcmz://open")!
    }
}
