import UIKit

/// The app's own tab bar under the web page: your three tabs, Ask AI and More, as a real
/// iPhone tab bar. The page says what's in it and which one is current
/// (frontend/src/lib/nativeShell.ts, message handler "crcmzShell"); a tap routes the page
/// in place (window.__crcmzGo), so calls and music keep going. Sign-in pages and a
/// fullscreen party get the whole screen.
@MainActor
final class Shell: NSObject, UITabBarDelegate {
    struct Item { let id, label, path, group: String }

    let bar = UITabBar()
    var go: ((String) -> Void)?
    var onVisible: ((Bool) -> Void)?
    weak var presenter: UIViewController?

    private var tabs: [Item] = []
    private var more: [Item] = []
    private var wantsHidden = true
    private var onAppPage = false
    private let tick = UISelectionFeedbackGenerator()
    private static let moreTag = 99

    override init() {
        super.init()
        bar.delegate = self
        bar.tintColor = UIColor(red: 0.69, green: 0.6, blue: 1, alpha: 1)
        bar.unselectedItemTintColor = UIColor(white: 1, alpha: 0.6)
        bar.overrideUserInterfaceStyle = .dark
        bar.isHidden = true
    }

    var isVisible: Bool { !bar.isHidden }

    /// From the page: {tabs, more, active, badge, hidden}.
    func update(_ m: [String: Any]) {
        func items(_ v: Any?) -> [Item] {
            (v as? [[String: Any]] ?? []).compactMap { d in
                guard let id = d["id"] as? String, let label = d["label"] as? String, let path = d["path"] as? String else { return nil }
                return Item(id: id, label: label, path: path, group: d["group"] as? String ?? "")
            }
        }
        let newTabs = items(m["tabs"])
        more = items(m["more"])
        if newTabs.map(\.id) != tabs.map(\.id) || bar.items == nil {
            tabs = newTabs
            var list = tabs.enumerated().map { i, t in
                UITabBarItem(title: t.label, image: UIImage(systemName: Self.symbol(t.id)), tag: i)
            }
            list.append(UITabBarItem(title: "More", image: UIImage(systemName: "ellipsis"), tag: Self.moreTag))
            bar.setItems(list, animated: false)
        }
        let badge = m["badge"] as? Int ?? 0
        for item in bar.items ?? [] where item.tag < tabs.count {
            item.badgeValue = tabs[item.tag].id == "squad" && badge > 0 ? String(badge) : nil
        }
        let active = m["active"] as? String
        if let i = tabs.firstIndex(where: { $0.id == active }) { bar.selectedItem = bar.items?[i] }
        else if more.contains(where: { $0.id == active }) { bar.selectedItem = bar.items?.last }
        else { bar.selectedItem = nil }
        wantsHidden = m["hidden"] as? Bool ?? false
        apply()
    }

    /// The web view moved to another page: off app.crcmz.me/app (sign-in) there's no bar.
    func pageChanged(_ url: URL?) {
        onAppPage = url?.host == "app.crcmz.me" && (url?.path.hasPrefix("/app") ?? false)
        if !onAppPage { tabs = []; bar.setItems(nil, animated: false) }
        apply()
    }

    private func apply() {
        let show = onAppPage && !wantsHidden && !tabs.isEmpty
        guard show == bar.isHidden else { return }
        bar.isHidden = !show
        onVisible?(show)
    }

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        tick.selectionChanged()
        if item.tag == Self.moreTag { showMore(); return }
        guard item.tag < tabs.count else { return }
        go?(tabs[item.tag].path)
    }

    #if DEBUG
    func demoMore() { showMore() }
    #endif

    private func showMore() {
        guard let presenter else { return }
        let list = MoreList(items: more) { [weak self] path in
            presenter.dismiss(animated: true)
            if let path { self?.go?(path) }
        }
        let nav = UINavigationController(rootViewController: list)
        nav.overrideUserInterfaceStyle = .dark
        if let sheet = nav.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        presenter.present(nav, animated: true)
    }

    static func symbol(_ id: String) -> String {
        switch id {
        case "squad": return "person.3.fill"
        case "clips": return "film.stack"
        case "slap": return "music.note"
        case "whatsapp": return "bubble.left.and.bubble.right.fill"
        case "giveaway": return "gift.fill"
        case "watch": return "play.tv.fill"
        case "huddle": return "video.fill"
        case "coach": return "brain.head.profile"
        case "ask": return "sparkles"
        case "notifications": return "bell.fill"
        case "portal": return "link"
        case "settings": return "gearshape.fill"
        case "help": return "questionmark.circle"
        case "admin": return "lock.shield"
        default: return "circle"
        }
    }
}

/// More: the pages that aren't in the bar, then your account, then "Change the tab bar".
private final class MoreList: UITableViewController {
    private let sections: [(String, [Shell.Item])]
    private let done: (String?) -> Void

    init(items: [Shell.Item], done: @escaping (String?) -> Void) {
        let edit = Shell.Item(id: "edit", label: "Change the tab bar", path: "/settings/app#tabbar", group: "account")
        sections = [("Squad", items.filter { $0.group == "squad" }),
                    ("Account", items.filter { $0.group != "squad" } + [edit])].filter { !$0.1.isEmpty }
        self.done = done
        super.init(style: .insetGrouped)
        title = "More"
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
        // Opaque, the app's own dark: the glass sheet over a bright page washes the rows out.
        tableView.backgroundColor = UIColor(red: 0.04, green: 0.03, blue: 0.09, alpha: 1)
        view.tintColor = UIColor(red: 0.69, green: 0.6, blue: 1, alpha: 1)
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in
            self?.done(nil)
        })
    }

    override func numberOfSections(in tableView: UITableView) -> Int { sections.count }
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? { sections[section].0 }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { sections[section].1.count }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let item = sections[indexPath.section].1[indexPath.row]
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        var c = cell.defaultContentConfiguration()
        c.text = item.label
        c.image = UIImage(systemName: item.id == "edit" ? "slider.horizontal.3" : Shell.symbol(item.id))
        cell.contentConfiguration = c
        cell.accessoryType = .disclosureIndicator
        cell.backgroundColor = UIColor(white: 1, alpha: 0.07)
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        done(sections[indexPath.section].1[indexPath.row].path)
    }
}
