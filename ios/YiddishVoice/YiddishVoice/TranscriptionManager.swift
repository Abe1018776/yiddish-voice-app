import Foundation
import SwiftUI

/// Central manager that coordinates recording, transcription, and keyboard extension communication.
/// Listens for Darwin notifications from the keyboard extension and handles the full
/// record -> transcribe -> store result pipeline.
final class TranscriptionManager: ObservableObject {
    @Published var state: TranscriptionState = .idle
    @Published var lastTranscription: String = ""
    @Published var errorMessage: String?

    let audioRecorder = AudioRecorder()
    private let apiClient = KohnAIClient()
    private let store = SharedStore.shared

    enum TranscriptionState: Equatable {
        case idle
        case recording
        case transcribing
        case done
        case error
    }

    init() {
        setupDarwinObservers()
    }

    deinit {
        DarwinNotificationCenter.shared.removeObserver(name: AppGroupConfig.startRecordingNotification)
        DarwinNotificationCenter.shared.removeObserver(name: AppGroupConfig.stopRecordingNotification)
    }

    // MARK: - Darwin Notification Handling (Keyboard Extension IPC)

    private func setupDarwinObservers() {
        DarwinNotificationCenter.shared.observe(name: AppGroupConfig.startRecordingNotification) { [weak self] in
            DispatchQueue.main.async {
                self?.startRecording()
            }
        }

        DarwinNotificationCenter.shared.observe(name: AppGroupConfig.stopRecordingNotification) { [weak self] in
            DispatchQueue.main.async {
                self?.stopRecordingAndTranscribe()
            }
        }
    }

    /// Called when the keyboard extension opens the app via URL scheme.
    func startRecordingFromKeyboard() {
        store.recordingRequested = true
        startRecording()
    }

    // MARK: - Recording

    func startRecording() {
        audioRecorder.requestPermission { [weak self] granted in
            guard let self = self else { return }
            guard granted else {
                self.errorMessage = "Microphone access denied. Please enable it in Settings."
                self.state = .error
                self.store.transcriptionStatus = "error"
                return
            }

            do {
                try self.audioRecorder.startRecording()
                self.state = .recording
                self.store.transcriptionStatus = "recording"
                self.errorMessage = nil
            } catch {
                self.errorMessage = "Failed to start recording: \(error.localizedDescription)"
                self.state = .error
                self.store.transcriptionStatus = "error"
            }
        }
    }

    func stopRecordingAndTranscribe() {
        guard state == .recording else { return }

        guard let audioData = audioRecorder.stopRecording() else {
            errorMessage = "No audio recorded"
            state = .error
            store.transcriptionStatus = "error"
            return
        }

        state = .transcribing
        store.transcriptionStatus = "transcribing"

        apiClient.transcribe(audioData: audioData) { [weak self] result in
            guard let self = self else { return }

            switch result {
            case .success(let text):
                self.lastTranscription = text
                self.state = .done
                self.store.transcriptionResult = text
                self.store.transcriptionStatus = "ready"
                self.store.addToHistory(text: text)
                // Notify keyboard extension that transcription is ready
                DarwinNotificationCenter.shared.post(name: AppGroupConfig.transcriptionReadyNotification)

            case .failure(let error):
                self.errorMessage = error.localizedDescription
                self.state = .error
                self.store.transcriptionStatus = "error"
            }
        }
    }

    func reset() {
        state = .idle
        store.transcriptionStatus = "idle"
        store.transcriptionResult = nil
        errorMessage = nil
    }
}
