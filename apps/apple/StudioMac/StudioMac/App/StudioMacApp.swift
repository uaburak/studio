import AppKit
import StudioKit
import SwiftUI

@main
struct StudioMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var settings: AppSettings
    @State private var model: AppModel

    init() {
        let settings = AppSettings()
        _settings = State(initialValue: settings)
        _model = State(initialValue: AppModel(settings: settings))
    }

    var body: some Scene {
        Window("Studio", id: "main") {
            RootView()
                .environment(model)
                .environment(settings)
                .task {
                    settings.applyAppearance()
                    // Not while rendering screenshots or hosting unit tests.
                    let underTest = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
                    if !SnapshotMode.isActive && !underTest {
                        await model.load()
                        model.applyLaunchRoute()
                    }
                }
                .onAppear { delegate.didShowMainWindow(model: model) }
        }
        .defaultSize(width: 1440, height: 900)
        .windowResizability(.contentMinSize)
        .windowToolbarStyle(.unified)
        .commands { StudioCommands(model: model, settings: settings) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        if SnapshotMode.isActive {
            SnapshotMode.run()
        }
    }

    @MainActor
    func didShowMainWindow(model: AppModel) {
        // `--window-id-file <path>`: write the window number so scripts can capture this window.
        let args = ProcessInfo.processInfo.arguments
        if !SnapshotMode.isActive, let index = args.firstIndex(of: "--window-id-file"), index + 1 < args.count {
            NSApp.activate(ignoringOtherApps: true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                if let window = NSApp.windows.first(where: { $0.identifier?.rawValue.contains("main") == true || $0.isMainWindow }) ?? NSApp.windows.first {
                    try? String(window.windowNumber).write(toFile: args[index + 1], atomically: true, encoding: .utf8)
                }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { !SnapshotMode.isActive }
}

/// Menu bar commands and keyboard shortcuts.
struct StudioCommands: Commands {
    let model: AppModel
    let settings: AppSettings

    var body: some Commands {
        CommandGroup(replacing: .appSettings) {
            Button("Ayarlar…") { model.settingsPresented = true }
                .keyboardShortcut(",", modifiers: .command)
        }
        CommandGroup(replacing: .newItem) {
            Button("Yeni sohbet") { model.startNewChat() }
                .keyboardShortcut("n", modifiers: .command)
        }
        CommandGroup(after: .newItem) {
            Button("Ara…") { model.searchPresented = true }
                .keyboardShortcut("k", modifiers: .command)
        }
        SidebarCommands()
        CommandGroup(after: .sidebar) {
            Button(model.inspectorPresented ? "Sağ paneli gizle" : "Sağ paneli göster") { model.toggleInspector() }
                .keyboardShortcut("i", modifiers: [.command, .option])
            Divider()
            Picker("Görünüm", selection: Binding(get: { settings.appearance }, set: { settings.appearance = $0 })) {
                ForEach(AppearancePreference.allCases) { option in
                    Text(option.label).tag(option)
                }
            }
            Button("Görünümü değiştir") { settings.appearance = settings.appearance.next }
                .keyboardShortcut("l", modifiers: [.command, .shift])
            Divider()
        }
        CommandMenu("Git") {
            Button("Geri") { model.goBack() }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(!model.canGoBack)
            Button("İleri") { model.goForward() }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(!model.canGoForward)
            Divider()
            Button("Postlar") { model.navigate(to: .posts) }
                .keyboardShortcut("p", modifiers: [.command, .shift])
        }
    }
}

extension AppearancePreference {
    /// Sistem -> Açık -> Koyu -> Sistem.
    var next: AppearancePreference {
        switch self {
        case .system: .light
        case .light: .dark
        case .dark: .system
        }
    }
}
