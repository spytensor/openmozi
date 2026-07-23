import AppKit
import Darwin
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let supportFolderName = "NativeBookmarkB05"
    private let bookmarkFileName = "folder.bookmark"
    private let resultFileName = "last-child-result.json"
    private let logFileName = "b05-app.log"

    private var window: NSWindow!
    private var logView: NSTextView!
    private var pickButton: NSButton!
    private var runButton: NSButton!
    private var revokeButton: NSButton!
    private var childRunning = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        appendLog("appLaunched bundle=\(Bundle.main.bundlePath)")
        appendLog("appSupport=\(appSupportDirectory.path)")

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            self?.runStoredBookmark(source: "launch")
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func buildWindow() {
        NSApp.setActivationPolicy(.regular)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 480),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "B0.5 Bookmark Grant Spike"
        window.center()

        let contentView = NSView()
        contentView.translatesAutoresizingMaskIntoConstraints = false
        window.contentView = contentView

        let title = NSTextField(labelWithString: "B0.5 Bookmark Grant Spike")
        title.font = NSFont.systemFont(ofSize: 20, weight: .semibold)

        let subtitle = NSTextField(labelWithString: "Pick a folder, then quit and relaunch to test the persisted security-scoped bookmark handoff.")
        subtitle.font = NSFont.systemFont(ofSize: 13)
        subtitle.textColor = .secondaryLabelColor
        subtitle.lineBreakMode = .byWordWrapping
        subtitle.maximumNumberOfLines = 2

        pickButton = NSButton(title: "Pick folder", target: self, action: #selector(pickFolder(_:)))
        runButton = NSButton(title: "Run grant check", target: self, action: #selector(runGrantCheck(_:)))
        revokeButton = NSButton(title: "Revoke bookmark", target: self, action: #selector(revokeBookmark(_:)))

        let buttonRow = NSStackView(views: [pickButton, runButton, revokeButton])
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8
        buttonRow.alignment = .leading

        logView = NSTextView()
        logView.isEditable = false
        logView.isSelectable = true
        logView.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        logView.textContainerInset = NSSize(width: 8, height: 8)

        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = false
        scrollView.borderType = .bezelBorder
        scrollView.documentView = logView

        let stack = NSStackView(views: [title, subtitle, buttonRow, scrollView])
        stack.orientation = .vertical
        stack.spacing = 12
        stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -20),
            scrollView.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scrollView.heightAnchor.constraint(greaterThanOrEqualToConstant: 260)
        ])

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func pickFolder(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.title = "Grant a folder to the B0.5 sandbox spike"
        panel.prompt = "Grant Folder"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true

        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            guard response == .OK, let selectedURL = panel.url else {
                self.appendLog("folderPickCancelled")
                return
            }

            do {
                let bookmark = try selectedURL.bookmarkData(
                    options: [.withSecurityScope],
                    includingResourceValuesForKeys: nil,
                    relativeTo: nil
                )
                try self.ensureAppSupportDirectory()
                try bookmark.write(to: self.bookmarkFileURL, options: .atomic)
                self.appendLog("bookmarkSaved path=\(selectedURL.path) bytes=\(bookmark.count)")
                self.runStoredBookmark(source: "pick")
            } catch {
                self.appendLog("bookmarkSaveFailed path=\(selectedURL.path) error=\(error.localizedDescription)")
                self.writeResultRecord([
                    "event": "bookmarkSaveFailed",
                    "path": selectedURL.path,
                    "error": error.localizedDescription,
                    "timestamp": Self.timestamp()
                ])
            }
        }
    }

    @objc private func runGrantCheck(_ sender: Any?) {
        runStoredBookmark(source: "manual")
    }

    @objc private func revokeBookmark(_ sender: Any?) {
        do {
            if FileManager.default.fileExists(atPath: bookmarkFileURL.path) {
                try FileManager.default.removeItem(at: bookmarkFileURL)
            }
            appendLog("bookmarkRevoked path=\(bookmarkFileURL.path)")
            writeResultRecord([
                "event": "bookmarkRevoked",
                "bookmarkPath": bookmarkFileURL.path,
                "timestamp": Self.timestamp()
            ])
        } catch {
            appendLog("bookmarkRevokeFailed error=\(error.localizedDescription)")
            writeResultRecord([
                "event": "bookmarkRevokeFailed",
                "bookmarkPath": bookmarkFileURL.path,
                "error": error.localizedDescription,
                "timestamp": Self.timestamp()
            ])
        }
    }

    private func runStoredBookmark(source: String) {
        guard !childRunning else {
            appendLog("grantCheckSkipped reason=childAlreadyRunning source=\(source)")
            return
        }

        guard FileManager.default.fileExists(atPath: bookmarkFileURL.path) else {
            appendLog("noStoredBookmark source=\(source) path=\(bookmarkFileURL.path)")
            writeResultRecord([
                "event": "noStoredBookmark",
                "source": source,
                "bookmarkPath": bookmarkFileURL.path,
                "timestamp": Self.timestamp()
            ])
            return
        }

        do {
            let bookmark = try Data(contentsOf: bookmarkFileURL)
            var stale = false
            let resolvedURL = try URL(
                resolvingBookmarkData: bookmark,
                options: [.withSecurityScope, .withoutUI],
                relativeTo: nil,
                bookmarkDataIsStale: &stale
            )

            let accessStarted = resolvedURL.startAccessingSecurityScopedResource()
            appendLog("bookmarkResolved source=\(source) path=\(resolvedURL.path) stale=\(stale) scopedAccessStarted=\(accessStarted)")

            guard accessStarted else {
                writeResultRecord([
                    "event": "scopedAccessFailed",
                    "source": source,
                    "grantedPath": resolvedURL.path,
                    "bookmarkPath": bookmarkFileURL.path,
                    "timestamp": Self.timestamp()
                ])
                return
            }

            if stale {
                refreshBookmark(for: resolvedURL)
            }

            childRunning = true
            setButtonsEnabled(false)

            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self else { return }
                let record = self.executeNodeGrantCheck(grantedURL: resolvedURL, source: source)
                resolvedURL.stopAccessingSecurityScopedResource()

                DispatchQueue.main.async {
                    self.childRunning = false
                    self.setButtonsEnabled(true)
                    self.writeResultRecord(record)

                    let status = record["terminationStatus"] as? Int ?? -1
                    self.appendLog("nodeChildFinished source=\(source) status=\(status) result=\(self.resultFileURL.path)")
                    if let stdout = record["stdout"] as? String, !stdout.isEmpty {
                        self.appendLog("nodeStdout \(stdout.trimmingCharacters(in: .whitespacesAndNewlines))")
                    }
                    if let stderr = record["stderr"] as? String, !stderr.isEmpty {
                        self.appendLog("nodeStderr \(stderr.trimmingCharacters(in: .whitespacesAndNewlines))")
                    }
                    self.appendLog("scopedAccessStopped path=\(resolvedURL.path)")
                }
            }
        } catch {
            appendLog("bookmarkResolveFailed source=\(source) error=\(error.localizedDescription)")
            writeResultRecord([
                "event": "bookmarkResolveFailed",
                "source": source,
                "bookmarkPath": bookmarkFileURL.path,
                "error": error.localizedDescription,
                "timestamp": Self.timestamp()
            ])
        }
    }

    private func refreshBookmark(for resolvedURL: URL) {
        do {
            let refreshed = try resolvedURL.bookmarkData(
                options: [.withSecurityScope],
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
            try refreshed.write(to: bookmarkFileURL, options: .atomic)
            appendLog("staleBookmarkRefreshed bytes=\(refreshed.count)")
        } catch {
            appendLog("staleBookmarkRefreshFailed error=\(error.localizedDescription)")
        }
    }

    private func executeNodeGrantCheck(grantedURL: URL, source: String) -> [String: Any] {
        let nodeURL = nodeExecutableURL()
        let scriptURL = nodeScriptURL()
        let outsideURL = outsideWriteURL()

        var record: [String: Any] = [
            "event": "nodeGrantCheck",
            "source": source,
            "timestamp": Self.timestamp(),
            "nodePath": nodeURL.path,
            "scriptPath": scriptURL.path,
            "grantedPath": grantedURL.path,
            "outsidePath": outsideURL.path
        ]

        guard FileManager.default.isExecutableFile(atPath: nodeURL.path) else {
            record["terminationStatus"] = 127
            record["spawnError"] = "Node helper is missing or not executable at \(nodeURL.path)"
            return record
        }

        guard FileManager.default.fileExists(atPath: scriptURL.path) else {
            record["terminationStatus"] = 126
            record["spawnError"] = "Node grant script is missing at \(scriptURL.path)"
            return record
        }

        let process = Process()
        process.executableURL = nodeURL
        process.arguments = [
            scriptURL.path,
            "--granted-path", grantedURL.path,
            "--outside-path", outsideURL.path
        ]

        var environment = ProcessInfo.processInfo.environment
        environment["MOZI_B05_GRANTED_PATH"] = grantedURL.path
        environment["MOZI_B05_OUTSIDE_PATH"] = outsideURL.path
        process.environment = environment

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
            process.waitUntilExit()

            let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
            let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()

            record["terminationStatus"] = Int(process.terminationStatus)
            record["terminationReason"] = "\(process.terminationReason)"
            record["stdout"] = String(data: stdoutData, encoding: .utf8) ?? ""
            record["stderr"] = String(data: stderrData, encoding: .utf8) ?? ""
        } catch {
            record["terminationStatus"] = 125
            record["spawnError"] = error.localizedDescription
        }

        return record
    }

    private func setButtonsEnabled(_ enabled: Bool) {
        pickButton.isEnabled = enabled
        runButton.isEnabled = enabled
        revokeButton.isEnabled = enabled
    }

    private var appSupportDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(supportFolderName, isDirectory: true)
    }

    private var bookmarkFileURL: URL {
        appSupportDirectory.appendingPathComponent(bookmarkFileName)
    }

    private var resultFileURL: URL {
        appSupportDirectory.appendingPathComponent(resultFileName)
    }

    private var logFileURL: URL {
        appSupportDirectory.appendingPathComponent(logFileName)
    }

    private func nodeExecutableURL() -> URL {
        if let override = ProcessInfo.processInfo.environment["MOZI_B05_NODE_PATH"], !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/node")
    }

    private func nodeScriptURL() -> URL {
        Bundle.main.resourceURL!.appendingPathComponent("node-grant-check.mjs")
    }

    private func outsideWriteURL() -> URL {
        if let passwd = getpwuid(getuid()), let homePointer = passwd.pointee.pw_dir {
            return URL(fileURLWithPath: String(cString: homePointer))
                .appendingPathComponent("Documents/mozi-should-fail.txt")
        }

        return URL(fileURLWithPath: "/Users/\(NSUserName())")
            .appendingPathComponent("Documents/mozi-should-fail.txt")
    }

    private func ensureAppSupportDirectory() throws {
        try FileManager.default.createDirectory(
            at: appSupportDirectory,
            withIntermediateDirectories: true,
            attributes: nil
        )
    }

    private func appendLog(_ message: String) {
        let line = "\(Self.timestamp()) \(message)\n"

        do {
            try ensureAppSupportDirectory()
            if !FileManager.default.fileExists(atPath: logFileURL.path) {
                try Data().write(to: logFileURL)
            }

            let handle = try FileHandle(forWritingTo: logFileURL)
            try handle.seekToEnd()
            if let data = line.data(using: .utf8) {
                try handle.write(contentsOf: data)
            }
            try handle.close()
        } catch {
            NSLog("B0.5 log write failed: %@", error.localizedDescription)
        }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.logView.string += line
            self.logView.scrollRangeToVisible(NSRange(location: self.logView.string.count, length: 0))
        }
    }

    private func writeResultRecord(_ record: [String: Any]) {
        do {
            try ensureAppSupportDirectory()
            let data = try JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: resultFileURL, options: .atomic)
        } catch {
            appendLog("resultWriteFailed error=\(error.localizedDescription)")
        }
    }

    private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
