import SwiftUI

struct HistoryView: View {
    @State private var history: [[String: Any]] = []

    var body: some View {
        NavigationStack {
            Group {
                if history.isEmpty {
                    ContentUnavailableView(
                        "No Transcriptions Yet",
                        systemImage: "clock",
                        description: Text("Your transcription history will appear here.")
                    )
                } else {
                    List {
                        ForEach(Array(history.enumerated()), id: \.offset) { index, entry in
                            historyRow(entry)
                                .swipeActions(edge: .trailing) {
                                    Button(role: .destructive) {
                                        deleteEntry(at: index)
                                    } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                        }
                    }
                }
            }
            .navigationTitle("History")
            .toolbar {
                if !history.isEmpty {
                    Button("Clear All", role: .destructive) {
                        SharedStore.shared.clearHistory()
                        loadHistory()
                    }
                }
            }
            .onAppear { loadHistory() }
        }
    }

    @ViewBuilder
    private func historyRow(_ entry: [String: Any]) -> some View {
        let text = entry["text"] as? String ?? ""
        let timestamp = entry["timestamp"] as? TimeInterval ?? 0

        VStack(alignment: .trailing, spacing: 6) {
            Text(text)
                .font(.body)
                .multilineTextAlignment(.trailing)
                .environment(\.layoutDirection, .rightToLeft)
                .frame(maxWidth: .infinity, alignment: .trailing)

            HStack {
                Button {
                    UIPasteboard.general.string = text
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.caption)
                }
                .buttonStyle(.borderless)

                Spacer()

                Text(formatDate(timestamp))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func loadHistory() {
        history = SharedStore.shared.getHistory()
    }

    private func deleteEntry(at index: Int) {
        history.remove(at: index)
        if let defaults = AppGroupConfig.sharedDefaults {
            defaults.set(history, forKey: "transcriptionHistory")
        }
    }

    private func formatDate(_ timestamp: TimeInterval) -> String {
        let date = Date(timeIntervalSince1970: timestamp)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
