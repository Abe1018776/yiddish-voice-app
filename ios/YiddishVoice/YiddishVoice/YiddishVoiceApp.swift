import SwiftUI

@main
struct YiddishVoiceApp: App {
    @StateObject private var transcriptionManager = TranscriptionManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(transcriptionManager)
                .onOpenURL { url in
                    handleURL(url)
                }
        }
    }

    private func handleURL(_ url: URL) {
        // Handle yiddishvoice://record from keyboard extension
        guard url.scheme == AppGroupConfig.urlScheme else { return }
        if url.host == AppGroupConfig.recordAction {
            transcriptionManager.startRecordingFromKeyboard()
        }
    }
}
