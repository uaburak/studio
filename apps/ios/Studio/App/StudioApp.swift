import SwiftUI

@main
struct StudioApp: App {
    @State private var app = AppModel(environment: .current())

    var body: some Scene {
        WindowGroup {
            if LaunchContext.isHostingUnitTests {
                // Unit tests run inside this process; keep the UI inert.
                Text("Studio — testler çalışıyor")
            } else {
                RootView()
                    .environment(app)
                    .environment(\.locale, Formatting.locale)
            }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var app = app
        TabView(selection: $app.selectedTab) {
            Tab("Ana sayfa", systemImage: "house", value: AppTab.home) {
                HomeView()
            }
            Tab("Yeni", systemImage: "square.and.pencil", value: AppTab.compose) {
                ComposeView()
            }
            Tab("İşler", systemImage: "gearshape.2", value: AppTab.jobs) {
                JobsView()
            }
            .badge(app.jobs.activeJobs.count)
            Tab("İnceleme", systemImage: "rectangle.stack", value: AppTab.review) {
                ContentListView()
            }
            Tab("Takvim", systemImage: "calendar", value: AppTab.calendar) {
                ScheduleListView()
            }
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            switch phase {
            case .active: Task { await app.activate() }
            case .background: app.deactivate()
            default: break
            }
        }
    }
}
