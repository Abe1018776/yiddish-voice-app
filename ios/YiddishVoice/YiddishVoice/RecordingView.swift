import SwiftUI

struct RecordingView: View {
    @EnvironmentObject var manager: TranscriptionManager

    var body: some View {
        NavigationStack {
            VStack(spacing: 32) {
                Spacer()

                // Status display
                statusView

                // Record button
                recordButton

                // Transcription result
                if !manager.lastTranscription.isEmpty && manager.state == .done {
                    transcriptionResult
                }

                // Error display
                if let error = manager.errorMessage {
                    Text(error)
                        .foregroundStyle(.red)
                        .font(.caption)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }

                Spacer()
            }
            .padding()
            .navigationTitle("Yiddish Voice")
        }
    }

    @ViewBuilder
    private var statusView: some View {
        switch manager.state {
        case .idle:
            Text("Tap to record")
                .font(.title2)
                .foregroundStyle(.secondary)
        case .recording:
            HStack(spacing: 8) {
                Circle()
                    .fill(.red)
                    .frame(width: 12, height: 12)
                Text("Recording...")
                    .font(.title2)
                    .foregroundStyle(.red)
            }
        case .transcribing:
            HStack(spacing: 8) {
                ProgressView()
                Text("Transcribing...")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            }
        case .done:
            Text("Done")
                .font(.title2)
                .foregroundStyle(.green)
        case .error:
            Text("Error")
                .font(.title2)
                .foregroundStyle(.red)
        }
    }

    private var recordButton: some View {
        Button {
            switch manager.state {
            case .idle, .done, .error:
                manager.reset()
                manager.startRecording()
            case .recording:
                manager.stopRecordingAndTranscribe()
            case .transcribing:
                break
            }
        } label: {
            ZStack {
                Circle()
                    .fill(manager.state == .recording ? .red : .blue)
                    .frame(width: 100, height: 100)
                    .shadow(color: manager.state == .recording ? .red.opacity(0.5) : .blue.opacity(0.3), radius: 10)

                Image(systemName: manager.state == .recording ? "stop.fill" : "mic.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(.white)
            }
        }
        .disabled(manager.state == .transcribing)
        .animation(.easeInOut(duration: 0.2), value: manager.state)

        // Audio level indicator
        if manager.state == .recording {
            AudioLevelView(level: manager.audioRecorder.audioLevel)
                .frame(height: 30)
                .padding(.horizontal, 40)
        }
    }

    private var transcriptionResult: some View {
        VStack(spacing: 12) {
            Text(manager.lastTranscription)
                .font(.body)
                .multilineTextAlignment(.trailing)
                .environment(\.layoutDirection, .rightToLeft)
                .padding()
                .frame(maxWidth: .infinity, alignment: .trailing)
                .background(Color(.systemGray6))
                .cornerRadius(12)

            HStack(spacing: 16) {
                Button {
                    UIPasteboard.general.string = manager.lastTranscription
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                        .font(.callout)
                }
                .buttonStyle(.bordered)

                Button {
                    manager.reset()
                } label: {
                    Label("Clear", systemImage: "xmark.circle")
                        .font(.callout)
                }
                .buttonStyle(.bordered)
                .tint(.secondary)
            }
        }
        .padding(.horizontal)
    }
}

struct AudioLevelView: View {
    let level: Float

    var body: some View {
        GeometryReader { geo in
            RoundedRectangle(cornerRadius: 4)
                .fill(.blue.opacity(0.3))
                .frame(width: geo.size.width)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(.blue)
                        .frame(width: geo.size.width * CGFloat(min(level * 5, 1.0)))
                }
        }
    }
}
