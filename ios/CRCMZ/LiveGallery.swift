#if DEBUG
import SwiftUI

/// Sample Watch Party states for the debug demo and gallery (never shipped: Debug only).
enum LiveSample {
    static let poster = "https://images.metahub.space/poster/medium/tt8367814/img"

    static func state(_ which: String, count: Int = 3, title: String = "The Gentlemen", names: [String] = ["mutasif", "moiiz41510", "ASamad89"],
                      poster: String? = LiveSample.poster, joined: Bool = false, isPrivate: Bool = false) -> CRCMZLiveAttributes.ContentState {
        let now = Date().timeIntervalSince1970
        let status = ["playing", "paused", "stale", "ended"].contains(which) ? which : "playing"
        return CRCMZLiveAttributes.ContentState(
            title: isPrivate ? "Watch Party" : title, subtitle: "\(count) watching", count: count, names: isPrivate ? [] : names,
            started: now - 1380, progress: 1380.0 / 6780, progressLabel: "23 of 113 min",
            paused: status != "playing", url: "/app/watch/party?room=crcmz",
            elapsed: 1380, duration: 6780, at: now, poster: isPrivate ? "" : poster,
            session: "watch:crcmz@1", status: status, rate: 1, rev: 1,
            people: isPrivate ? "" : people(names, count), joined: joined, private: isPrivate)
    }

    private static func people(_ names: [String], _ count: Int) -> String {
        let shown = names.prefix(2)
        let more = max(0, count - shown.count)
        return shown.joined(separator: ", ") + (more > 0 && !shown.isEmpty ? " +\(more.formatted(.number.notation(.compactName)))" : "")
    }
}

/// -crcmzLiveGallery <lock|dark|island|edge>: the Watch Party's Live Activity drawn at its
/// real sizes, for screenshots (a simulator can't lock the screen or expand the island
/// from the command line). lock / dark: the lock screen card in each state, light or
/// dark; island: compact, minimal and expanded; edge: long title, big counts, nobody,
/// no poster, private, joined, larger text.
struct LiveGallery: View {
    let page: String
    @State private var ready = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if ready { content } else { ProgressView() }
            }
            .padding(.horizontal, 12).padding(.vertical, 60)
        }
        .background(page == "dark" || page == "island" ? Color(white: 0.12) : Color(white: 0.82))
        .environment(\.colorScheme, page == "lock" ? .light : .dark)
        .task {
            await LivePoster.cache(LiveSample.poster)
            ready = true
        }
    }

    @ViewBuilder private var content: some View {
        switch page {
        case "island": island
        case "edge": edge
        default:
            ForEach(["playing", "paused", "stale", "ended"], id: \.self) { s in
                lock(label: s.uppercased(), PartyNow(LiveSample.state(s == "stale" ? "playing" : s), key: "watch:crcmz", stale: s == "stale"))
            }
        }
    }

    private var edge: some View {
        Group {
            lock(label: "LONG TITLE · 1.2K WATCHING · JOINED", PartyNow(LiveSample.state("playing", count: 1240,
                 title: "The Lord of the Rings: The Return of the King (Extended Edition)", joined: true), key: "watch:crcmz"))
            lock(label: "NOBODY YET · NO POSTER", PartyNow(LiveSample.state("playing", count: 0, names: [], poster: nil), key: "watch:crcmz"))
            lock(label: "PRIVATE (NO FILM OR NAMES)", PartyNow(LiveSample.state("playing", isPrivate: true), key: "watch:crcmz"))
            lock(label: "LARGER TEXT (XXL)", PartyNow(LiveSample.state("playing"), key: "watch:crcmz"))
                .dynamicTypeSize(.xxLarge)
        }
    }

    private var island: some View {
        let p = PartyNow(LiveSample.state("playing"), key: "watch:crcmz")
        return VStack(alignment: .leading, spacing: 14) {
            caption("COMPACT")
            HStack(spacing: 0) {
                WatchCompactLeading(party: p).frame(width: 52)
                Color.clear.frame(width: 126)
                WatchCompactTrailing(party: p).frame(width: 52)
            }
            .frame(height: 37).background(Capsule().fill(.black))
            caption("MINIMAL (WITH ANOTHER ACTIVITY)")
            HStack(spacing: 8) {
                Capsule().fill(.black).frame(width: 126, height: 37)
                WatchMinimal(party: p).frame(width: 37, height: 37).background(Circle().fill(.black))
            }
            caption("EXPANDED")
            VStack(spacing: 8) {
                HStack(alignment: .top, spacing: 8) {
                    WatchIslandLeading(party: p)
                    WatchIslandCenter(party: p)
                    WatchIslandTrailing(party: p)
                }
                WatchIslandBottom(party: p)
            }
            .padding(.horizontal, 18).padding(.vertical, 14)
            .frame(width: 371)
            .background(RoundedRectangle(cornerRadius: 44, style: .continuous).fill(.black))
            caption("EXPANDED · PAUSED")
            let paused = PartyNow(LiveSample.state("paused"), key: "watch:crcmz")
            VStack(spacing: 8) {
                HStack(alignment: .top, spacing: 8) {
                    WatchIslandLeading(party: paused)
                    WatchIslandCenter(party: paused)
                    WatchIslandTrailing(party: paused)
                }
                WatchIslandBottom(party: paused)
            }
            .padding(.horizontal, 18).padding(.vertical, 14)
            .frame(width: 371)
            .background(RoundedRectangle(cornerRadius: 44, style: .continuous).fill(.black))
        }
    }

    private func lock(label: String, _ p: PartyNow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            caption(label)
            WatchCard(party: p)
                .frame(width: 366)
                .frame(maxHeight: 160, alignment: .top)
                .background(LivePalette.background)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
    }

    private func caption(_ s: String) -> some View {
        Text(s).font(.caption2.weight(.bold)).foregroundStyle(page == "lock" || page == "edge" ? Color.black.opacity(0.6) : Color.white.opacity(0.6))
    }
}
#endif
