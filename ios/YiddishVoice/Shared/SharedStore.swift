import Foundation

/// Shared data store using App Group UserDefaults for IPC between keyboard and main app.
final class SharedStore {
    static let shared = SharedStore()

    private let defaults: UserDefaults?

    private init() {
        defaults = AppGroupConfig.sharedDefaults
    }

    // MARK: - Transcription Result

    var transcriptionResult: String? {
        get { defaults?.string(forKey: AppGroupConfig.transcriptionResultKey) }
        set { defaults?.set(newValue, forKey: AppGroupConfig.transcriptionResultKey) }
    }

    /// Status: "idle", "recording", "transcribing", "ready", "error"
    var transcriptionStatus: String {
        get { defaults?.string(forKey: AppGroupConfig.transcriptionStatusKey) ?? "idle" }
        set { defaults?.set(newValue, forKey: AppGroupConfig.transcriptionStatusKey) }
    }

    var recordingRequested: Bool {
        get { defaults?.bool(forKey: AppGroupConfig.recordingRequestKey) ?? false }
        set { defaults?.set(newValue, forKey: AppGroupConfig.recordingRequestKey) }
    }

    // MARK: - Settings

    var apiBaseURL: String {
        get { defaults?.string(forKey: AppGroupConfig.apiBaseURLKey) ?? AppGroupConfig.defaultAPIBaseURL }
        set { defaults?.set(newValue, forKey: AppGroupConfig.apiBaseURLKey) }
    }

    var apiKey: String {
        get { defaults?.string(forKey: AppGroupConfig.apiKeyKey) ?? "" }
        set { defaults?.set(newValue, forKey: AppGroupConfig.apiKeyKey) }
    }

    var model: String {
        get { defaults?.string(forKey: AppGroupConfig.modelKey) ?? AppGroupConfig.defaultModel }
        set { defaults?.set(newValue, forKey: AppGroupConfig.modelKey) }
    }

    var autoInsert: Bool {
        get { defaults?.object(forKey: AppGroupConfig.autoInsertKey) as? Bool ?? true }
        set { defaults?.set(newValue, forKey: AppGroupConfig.autoInsertKey) }
    }

    // MARK: - Transcription History

    private let historyKey = "transcriptionHistory"
    private let maxHistoryItems = 50

    func addToHistory(text: String) {
        var history = getHistory()
        let entry: [String: Any] = [
            "text": text,
            "timestamp": Date().timeIntervalSince1970
        ]
        history.insert(entry, at: 0)
        if history.count > maxHistoryItems {
            history = Array(history.prefix(maxHistoryItems))
        }
        defaults?.set(history, forKey: historyKey)
    }

    func getHistory() -> [[String: Any]] {
        defaults?.array(forKey: historyKey) as? [[String: Any]] ?? []
    }

    func clearHistory() {
        defaults?.removeObject(forKey: historyKey)
    }
}
