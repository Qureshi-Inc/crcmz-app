import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Share → CRCMZ: a song from Spotify, Apple Music, YouTube Music, SoundCloud, Deezer or
/// Tidal goes into the Slap library, in your picks (POST /api/slap/share, signed in with
/// the app's session, SharedSession). You get a notification when it's in.
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        model.close = { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }
        let host = UIHostingController(rootView: ShareCard(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.view.backgroundColor = .clear
        view.addSubview(host.view)
        host.didMove(toParent: self)
        Task { await model.run(extensionContext?.inputItems as? [NSExtensionItem] ?? []) }
    }
}

@MainActor
final class ShareModel: ObservableObject {
    enum Phase { case working, done(String), already(String), failed(String) }
    @Published var phase: Phase = .working
    var close: () -> Void = {}

    private static let music = try! NSRegularExpression(
        pattern: #"https://(music\.apple\.com|open\.spotify\.com|music\.youtube\.com|soundcloud\.com|(www\.)?deezer\.com|tidal\.com|listen\.tidal\.com)/\S+"#,
        options: .caseInsensitive)

    func run(_ items: [NSExtensionItem]) async {
        var text = items.compactMap { $0.attributedContentText?.string }.joined(separator: " ")
        for p in items.flatMap({ $0.attachments ?? [] }) {
            if p.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               let u = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                text += " " + u.absoluteString
            } else if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                      let t = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                text += " " + t
            }
        }
        let range = NSRange(text.startIndex..., in: text)
        guard let m = Self.music.firstMatch(in: text, range: range), let r = Range(m.range, in: text) else {
            phase = .failed("Share a song from Spotify, Apple Music, YouTube Music, SoundCloud, Deezer or Tidal.")
            return
        }
        guard let session = SharedSession.read() else {
            phase = .failed("Open the CRCMZ app and sign in once, then share again.")
            return
        }
        var rq = URLRequest(url: URL(string: "https://app.crcmz.me/api/slap/share")!)
        rq.httpMethod = "POST"
        rq.timeoutInterval = 45
        rq.setValue("application/json", forHTTPHeaderField: "Content-Type")
        rq.setValue("https://app.crcmz.me", forHTTPHeaderField: "Origin")
        rq.setValue("psn_session=\(session)", forHTTPHeaderField: "Cookie")
        rq.httpBody = try? JSONSerialization.data(withJSONObject: ["url": String(text[r]), "text": String(text.prefix(2000))])
        do {
            let (data, resp) = try await URLSession.shared.data(for: rq)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            let title = [json["title"] as? String, json["artist"] as? String].compactMap { $0 }.joined(separator: " · ")
            switch code {
            case 200:
                phase = json["status"] as? String == "already_in_library" ? .already(title.isEmpty ? "That song" : title) : .done(title.isEmpty ? "Your song" : title)
                try? await Task.sleep(nanoseconds: 2_200_000_000)
                close()
            case 401: phase = .failed("Open the CRCMZ app and sign in again, then share again.")
            default: phase = .failed((json["detail"] as? String) ?? "Couldn't add that song.")
            }
        } catch {
            phase = .failed("Couldn't reach CRCMZ. Check your connection and try again.")
        }
    }
}

private struct ShareCard: View {
    @ObservedObject var model: ShareModel

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "music.note").font(.system(size: 34, weight: .semibold)).foregroundStyle(.cyan)
            switch model.phase {
            case .working:
                ProgressView("Adding to Slap…").tint(.white)
            case .done(let t):
                Text("Downloading \(t)").font(.headline).multilineTextAlignment(.center)
                Text("It goes into your picks in Slap. You'll get a notification when it's in.").font(.subheadline)
                    .foregroundStyle(.secondary).multilineTextAlignment(.center)
            case .already(let t):
                Text("\(t) is already in Slap").font(.headline).multilineTextAlignment(.center)
            case .failed(let why):
                Text("Couldn't add it").font(.headline)
                Text(why).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            Button("Done") { model.close() }.buttonStyle(.borderedProminent).tint(Color(red: 0.66, green: 0.33, blue: 0.97))
        }
        .padding(24)
        .frame(maxWidth: 360)
        .foregroundStyle(.white)
        .background(RoundedRectangle(cornerRadius: 24).fill(Color(red: 0.055, green: 0.04, blue: 0.11)))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.35).ignoresSafeArea())
        .environment(\.colorScheme, .dark)
    }
}
