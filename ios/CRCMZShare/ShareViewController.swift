import AVFoundation
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Share → CRCMZ. The server says what a link is (POST /api/share/inspect, share.py):
///   a song      added to Slap straight away, in your picks, with Undo
///   a trailer   add its film to Movies (4K / 1080p when both exist), or play the trailer
///               in the Watch Party
///   an IMDb page  add the film
///   a video     the Watch Party
/// A video from Photos goes to Clips' Send a video (the same upload, caption and queue as
/// the app). Everything is sent as you: the app's session, from SharedSession.
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
        Task { await model.start(extensionContext?.inputItems as? [NSExtensionItem] ?? []) }
    }
}

// MARK: - The server

private enum API {
    static let base = URL(string: "https://app.crcmz.me")!

    struct Failure: Error { let message: String; let status: Int }

    static func call(_ path: String, method: String = "GET", json: [String: Any]? = nil,
                     body: Data? = nil, timeout: TimeInterval = 45) async throws -> [String: Any] {
        guard let session = SharedSession.read() else {
            throw Failure(message: "Open the CRCMZ app and sign in once, then share again.", status: 401)
        }
        var rq = URLRequest(url: URL(string: path, relativeTo: base)!)
        rq.httpMethod = method
        rq.timeoutInterval = timeout
        rq.setValue("https://app.crcmz.me", forHTTPHeaderField: "Origin")
        rq.setValue("psn_session=\(session)", forHTTPHeaderField: "Cookie")
        if let json {
            rq.setValue("application/json", forHTTPHeaderField: "Content-Type")
            rq.httpBody = try? JSONSerialization.data(withJSONObject: json)
        } else if let body {
            rq.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            rq.httpBody = body
        }
        let (data, resp) = try await URLSession.shared.data(for: rq)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let out = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(code) else {
            if code == 401 { throw Failure(message: "Open the CRCMZ app and sign in again, then share again.", status: 401) }
            throw Failure(message: (out["detail"] as? String) ?? (out["error"] as? String) ?? "That didn't work.", status: code)
        }
        return out
    }
}

// MARK: - What the card shows

struct Movie { let imdb: String; let title: String; let year: String; let poster: URL?; let inLibrary: Bool }

@MainActor
final class ShareModel: ObservableObject {
    enum Phase {
        case looking
        case choose(kind: String, link: String, movie: Movie?, videoTitle: String, choices: [String])
        case qualities(Movie, fourK: String?, hd: String?)
        case songAdded(name: String, job: String?, downloading: Bool)
        case clip(file: URL, name: String)
        case uploading(Double)
        case message(title: String, detail: String, undo: (() -> Void)?)
    }
    @Published var phase: Phase = .looking
    @Published var busy = false
    var close: () -> Void = {}
    private var uploadedID: String?

    func start(_ items: [NSExtensionItem]) async {
        var text = items.compactMap { $0.attributedContentText?.string }.joined(separator: " ")
        for p in items.flatMap({ $0.attachments ?? [] }) {
            if p.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                if let url = await movieFile(p) { phase = .clip(file: url, name: url.lastPathComponent); return }
            } else if p.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                      let u = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                text += " " + u.absoluteString
            } else if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                      let t = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                text += " " + t
            }
        }
        do {
            let r = try await API.call("/api/share/inspect", method: "POST", json: ["text": String(text.prefix(2000))], timeout: 20)
            let kind = r["kind"] as? String ?? "none"
            let link = r["link"] as? String ?? ""
            if kind == "none" || link.isEmpty {
                phase = .message(title: "There's no link in that", detail: "Share a song, a video or a movie page.", undo: nil)
                return
            }
            if r["auto"] as? String == "slap" { await addSong(link); return }
            let m = r["movie"] as? [String: Any]
            let movie = m.map { Movie(imdb: $0["imdb"] as? String ?? "", title: $0["title"] as? String ?? "",
                                      year: $0["year"] as? String ?? "", poster: URL(string: $0["poster"] as? String ?? ""),
                                      inLibrary: $0["in_library"] as? Bool ?? false) }
            phase = .choose(kind: kind, link: link, movie: movie, videoTitle: r["video_title"] as? String ?? "",
                            choices: r["choices"] as? [String] ?? ["watch"])
        } catch let e as API.Failure {
            phase = .message(title: "Couldn't share that", detail: e.message, undo: nil)
        } catch {
            phase = .message(title: "Couldn't reach CRCMZ", detail: "Check your connection and try again.", undo: nil)
        }
    }

    /// A video from Photos, copied where this extension can read it while it uploads.
    private func movieFile(_ p: NSItemProvider) async -> URL? {
        await withCheckedContinuation { cont in
            p.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier) { url, _ in
                guard let url else { cont.resume(returning: nil); return }
                let dest = FileManager.default.temporaryDirectory.appendingPathComponent(url.lastPathComponent)
                try? FileManager.default.removeItem(at: dest)
                cont.resume(returning: (try? FileManager.default.copyItem(at: url, to: dest)) != nil ? dest : nil)
            }
        }
    }

    // MARK: Songs

    func addSong(_ link: String) async {
        busy = true
        defer { busy = false }
        do {
            let r = try await API.call("/api/slap/share", method: "POST", json: ["url": link])
            let name = [r["title"] as? String, r["artist"] as? String].compactMap { $0 }.joined(separator: " · ")
            phase = .songAdded(name: name.isEmpty ? "Your song" : name, job: r["job"] as? String,
                               downloading: r["status"] as? String == "downloading")
        } catch let e as API.Failure {
            phase = .message(title: "Couldn't add it", detail: e.message, undo: nil)
        } catch {
            phase = .message(title: "Couldn't reach CRCMZ", detail: "Check your connection and try again.", undo: nil)
        }
    }

    func undoSong(_ job: String, name: String) async {
        busy = true
        defer { busy = false }
        _ = try? await API.call("/api/slap/share/undo", method: "POST", json: ["job": job])
        phase = .message(title: "Undone", detail: "\(name) won't be added.", undo: nil)
    }

    // MARK: Movies and the Watch Party

    func addMovie(_ m: Movie) async {
        busy = true
        defer { busy = false }
        do {
            let o = try await API.call("/api/watch/movies/options/\(m.imdb)", timeout: 30)
            let label = { (k: String) -> String? in
                guard let q = o[k] as? [String: Any] else { return nil }
                return q["label"] as? String ?? (q["size_gb"].map { "\($0) GB" } ?? "")
            }
            let fourK = label("4k"), hd = label("1080p")
            if fourK != nil && hd != nil { phase = .qualities(m, fourK: fourK, hd: hd); return }
            await addMovie(m, quality: "")
        } catch {
            await addMovie(m, quality: "")
        }
    }

    func addMovie(_ m: Movie, quality: String) async {
        busy = true
        defer { busy = false }
        do {
            var body: [String: Any] = ["imdb": m.imdb]
            if !quality.isEmpty { body["quality"] = quality }
            _ = try await API.call("/api/watch/movies/add", method: "POST", json: body, timeout: 60)
            phase = .message(title: "Adding \(m.title)", detail: "It's on its way to Movies. Everyone hears when it's ready to watch.", undo: nil)
        } catch let e as API.Failure {
            phase = .message(title: "Couldn't add \(m.title)", detail: e.message, undo: nil)
        } catch {
            phase = .message(title: "Couldn't reach CRCMZ", detail: "Check your connection and try again.", undo: nil)
        }
    }

    /// This can't open the app, so the link waits on the server for the app's next open.
    func watch(_ link: String) async {
        busy = true
        defer { busy = false }
        _ = try? await API.call("/api/share/pending", method: "POST", json: ["url": link])
        phase = .message(title: "Ready in the Watch Party", detail: "Open CRCMZ and it plays there for the party.", undo: nil)
    }

    // MARK: Clips

    func sendClip(_ file: URL, caption: String) async {
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
        let ext = file.pathExtension.lowercased()
        guard ext == "mp4" || ext == "mov" else {
            phase = .message(title: "That video can't go to Clips", detail: "Clips takes MP4 or MOV videos.", undo: nil); return
        }
        let secs = (try? await AVURLAsset(url: file).load(.duration).seconds) ?? 0
        if secs > 0 && (secs < 3 || secs > 600.5) {
            phase = .message(title: "That video can't go to Clips", detail: "It has to be between 3 seconds and 10 minutes.", undo: nil); return
        }
        phase = .uploading(0)
        do {
            var s = try await API.call("/api/video-uploads/start", method: "POST",
                                       json: ["filename": file.lastPathComponent, "size": size, "caption": caption, "file_key": "\(file.lastPathComponent):\(size)"])
            let id = s["upload_id"] as? String ?? ""
            let chunk = s["chunk_bytes"] as? Int ?? 8 * 1024 * 1024
            var off = s["received"] as? Int ?? 0
            let h = try FileHandle(forReadingFrom: file)
            defer { try? h.close() }
            while off < size {
                try h.seek(toOffset: UInt64(off))
                let data = h.readData(ofLength: chunk)
                s = try await API.call("/api/video-uploads/chunk?id=\(id)&offset=\(off)", method: "PUT", body: data, timeout: 120)
                off = s["received"] as? Int ?? (off + data.count)
                phase = .uploading(size > 0 ? Double(off) / Double(size) : 1)
            }
            let fin = try await API.call("/api/video-uploads/finish", method: "POST", json: ["upload_id": id], timeout: 180)
            uploadedID = ((fin["upload"] as? [String: Any])?["video_post_id"]).map { "\($0)" }
            phase = .message(title: "Queued ✓", detail: "Muse posts it once it's through the queue, credited to you.",
                             undo: uploadedID == nil ? nil : { [weak self] in Task { await self?.withdrawClip() } })
        } catch let e as API.Failure {
            phase = .message(title: "Couldn't send it",
                             detail: e.status == 403 ? "Link your PlayStation account in the app first: Clips are credited to your PSN ID." : e.message, undo: nil)
        } catch {
            phase = .message(title: "The upload stopped", detail: "Check your connection and share it again.", undo: nil)
        }
    }

    func withdrawClip() async {
        guard let id = uploadedID else { return }
        busy = true
        defer { busy = false }
        _ = try? await API.call("/api/video-uploads/withdraw", method: "POST", json: ["video_post_id": Int(id) ?? id])
        phase = .message(title: "Undone", detail: "The video won't be posted.", undo: nil)
    }
}

// MARK: - The card

private let violet = Color(red: 0.66, green: 0.33, blue: 0.97)

private struct ShareCard: View {
    @ObservedObject var model: ShareModel
    @State private var caption = ""

    var body: some View {
        VStack(spacing: 14) {
            content
        }
        .padding(22)
        .frame(maxWidth: 380)
        .foregroundStyle(.white)
        .background(RoundedRectangle(cornerRadius: 24).fill(Color(red: 0.055, green: 0.04, blue: 0.11)))
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.35).ignoresSafeArea())
        .environment(\.colorScheme, .dark)
        .disabled(model.busy)
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .looking:
            ProgressView("Looking at that…").tint(.white)
        case let .choose(kind, link, movie, videoTitle, choices):
            if let m = movie {
                HStack(spacing: 12) {
                    AsyncImage(url: m.poster) { $0.resizable().scaledToFill() } placeholder: { Color.white.opacity(0.08) }
                        .frame(width: 60, height: 90).clipShape(RoundedRectangle(cornerRadius: 8))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(m.year.isEmpty ? m.title : "\(m.title) (\(m.year))").font(.headline)
                        Text(kind == "trailer" ? "The film this trailer is for" : "From IMDb").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
            } else {
                Image(systemName: "play.rectangle.fill").font(.system(size: 30)).foregroundStyle(.cyan)
                Text(videoTitle.isEmpty ? link : videoTitle).font(.headline).multilineTextAlignment(.center).lineLimit(3)
            }
            ForEach(Array(choices.enumerated()), id: \.offset) { i, c in
                button(c, primary: i == 0, link: link, movie: movie, kind: kind)
            }
            Button("Cancel") { model.close() }.foregroundStyle(.secondary)
        case let .qualities(m, fourK, hd):
            Text("Add \(m.title)").font(.headline)
            Button { Task { await model.addMovie(m, quality: "4k") } } label: { Label("4K\(fourK.map { " · \($0)" } ?? "")", systemImage: "sparkles.tv") }
                .buttonStyle(Wide(primary: true))
            Button { Task { await model.addMovie(m, quality: "1080p") } } label: { Label("1080p\(hd.map { " · \($0)" } ?? "")", systemImage: "tv") }
                .buttonStyle(Wide(primary: false))
        case let .songAdded(name, job, downloading):
            Image(systemName: "music.note").font(.system(size: 32, weight: .semibold)).foregroundStyle(.cyan)
            Text(downloading ? "Adding \(name)" : "\(name) is already in Slap").font(.headline).multilineTextAlignment(.center)
            if downloading {
                Text("It goes into your picks. You'll get a notification when it's in.").font(.subheadline)
                    .foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            HStack(spacing: 10) {
                if downloading, let job {
                    Button("Undo") { Task { await model.undoSong(job, name: name) } }.buttonStyle(Wide(primary: false))
                }
                Button("Done") { model.close() }.buttonStyle(Wide(primary: true))
            }
        case let .clip(file, name):
            Image(systemName: "film.stack").font(.system(size: 30)).foregroundStyle(.cyan)
            Text("Send to Clips").font(.headline)
            Text(name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            TextField("Caption (optional)", text: $caption, axis: .vertical)
                .lineLimit(1...3).padding(10).background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.08)))
                .onChange(of: caption) { v in if v.count > 150 { caption = String(v.prefix(150)) } }
            Button { Task { await model.sendClip(file, caption: caption) } } label: { Label("Send", systemImage: "paperplane.fill") }
                .buttonStyle(Wide(primary: true))
            Button("Cancel") { model.close() }.foregroundStyle(.secondary)
        case let .uploading(p):
            ProgressView(value: p) { Text("Sending to Clips…") }.tint(violet)
            Text("Keep this open until it's sent.").font(.caption).foregroundStyle(.secondary)
        case let .message(title, detail, undo):
            Text(title).font(.headline).multilineTextAlignment(.center)
            Text(detail).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            HStack(spacing: 10) {
                if let undo { Button("Undo", action: undo).buttonStyle(Wide(primary: false)) }
                Button("Done") { model.close() }.buttonStyle(Wide(primary: true))
            }
        }
    }

    @ViewBuilder private func button(_ c: String, primary: Bool, link: String, movie: Movie?, kind: String) -> some View {
        switch c {
        case "movie":
            if let m = movie {
                if m.inLibrary {
                    Button { Task { await model.watch("https://app.crcmz.me/app/watch?m=\(m.imdb)") } } label: { Label("It's in Movies: watch it", systemImage: "play.fill") }
                        .buttonStyle(Wide(primary: primary))
                } else {
                    Button { Task { await model.addMovie(m) } } label: { Label("Add to Movies", systemImage: "plus") }.buttonStyle(Wide(primary: primary))
                }
            }
        case "slap":
            Button { Task { await model.addSong(link) } } label: { Label("Add the song to Slap", systemImage: "music.note") }.buttonStyle(Wide(primary: primary))
        default:
            Button { Task { await model.watch(link) } } label: {
                Label(kind == "trailer" ? "Play the trailer in the Watch Party" : "Play in the Watch Party", systemImage: "play.tv")
            }.buttonStyle(Wide(primary: primary))
        }
    }
}

private struct Wide: ButtonStyle {
    let primary: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 46)
            .background(RoundedRectangle(cornerRadius: 14).fill(primary ? violet : Color.white.opacity(0.12)))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}
