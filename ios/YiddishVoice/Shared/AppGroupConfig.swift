import Foundation

/// Shared constants for App Group communication between main app and keyboard extension.
enum AppGroupConfig {
    static let suiteName = "group.com.yiddishvoice.shared"

    // MARK: - UserDefaults Keys
    static let transcriptionResultKey = "transcriptionResult"
    static let transcriptionStatusKey = "transcriptionStatus"
    static let recordingRequestKey = "recordingRequest"
    static let apiBaseURLKey = "apiBaseURL"
    static let apiKeyKey = "apiKey"
    static let modelKey = "model"
    static let autoInsertKey = "autoInsert"

    // MARK: - Darwin Notification Names
    static let startRecordingNotification = "com.yiddishvoice.startRecording"
    static let stopRecordingNotification = "com.yiddishvoice.stopRecording"
    static let transcriptionReadyNotification = "com.yiddishvoice.transcriptionReady"

    // MARK: - URL Scheme
    static let urlScheme = "yiddishvoice"
    static let recordAction = "record"

    // MARK: - Defaults
    static let defaultAPIBaseURL = "https://api.kohnai.ai"
    static let defaultModel = "gemini"

    /// Shared UserDefaults instance for the App Group.
    static var sharedDefaults: UserDefaults? {
        UserDefaults(suiteName: suiteName)
    }
}
