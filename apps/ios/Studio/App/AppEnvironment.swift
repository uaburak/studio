import Foundation

/// Everything the app talks to outside its own memory. `live()` is the real
/// thing; the UI tests launch with stubs (see Debug/StubBackend.swift).
struct AppEnvironment: Sendable {
    var preferences: Preferences
    var credentials: any CredentialStore
    /// URLSession for HTTP calls (stub mode injects a URLProtocol).
    var makeSession: @Sendable () -> URLSession
    var webSocketConnector: any WebSocketConnecting
    var push: any PushRegistering

    static func live() -> AppEnvironment {
        AppEnvironment(
            preferences: Preferences(defaults: .standard),
            credentials: KeychainCredentialStore(),
            makeSession: { APIClient.makeSession() },
            webSocketConnector: URLSessionWebSocketConnector(),
            push: DisabledPushRegistration())
    }

    /// Picks the environment from launch arguments.
    static func current(arguments: [String] = ProcessInfo.processInfo.arguments) -> AppEnvironment {
        #if DEBUG
        if arguments.contains(StubBackend.launchArgument) {
            return StubBackend.environment()
        }
        #endif
        return live()
    }
}

/// True while the app only hosts unit tests: skip networking on launch.
enum LaunchContext {
    static var isHostingUnitTests: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
            && !ProcessInfo.processInfo.arguments.contains("-StudioUITest")
    }
}
