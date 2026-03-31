import SwiftUI

struct SettingsView: View {
    @State private var apiBaseURL: String = ""
    @State private var apiKey: String = ""
    @State private var model: String = ""
    @State private var autoInsert: Bool = true
    @State private var showSaved = false

    private let store = SharedStore.shared

    private let modelOptions = ["gemini", "whisper", "omniasr"]

    var body: some View {
        NavigationStack {
            Form {
                Section("API Configuration") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("API Base URL")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        TextField("https://api.kohnai.ai", text: $apiBaseURL)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .autocapitalization(.none)
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("API Key")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        SecureField("Enter API key", text: $apiKey)
                            .textContentType(.password)
                    }

                    Picker("Model", selection: $model) {
                        ForEach(modelOptions, id: \.self) { option in
                            Text(option).tag(option)
                        }
                    }
                }

                Section("Keyboard") {
                    Toggle("Auto-insert transcription", isOn: $autoInsert)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Keyboard Setup")
                            .font(.headline)
                        Text("1. Open Settings > General > Keyboard > Keyboards")
                        Text("2. Tap \"Add New Keyboard\"")
                        Text("3. Select \"Yiddish Voice\"")
                        Text("4. Enable \"Allow Full Access\"")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                Section {
                    Button("Save Settings") {
                        saveSettings()
                    }
                    .frame(maxWidth: .infinity)

                    if showSaved {
                        Text("Settings saved!")
                            .foregroundStyle(.green)
                            .font(.caption)
                            .frame(maxWidth: .infinity)
                    }
                }

                Section("About") {
                    LabeledContent("App", value: "Yiddish Voice")
                    LabeledContent("Version", value: "1.0.0")
                    LabeledContent("API", value: apiBaseURL)
                }
            }
            .navigationTitle("Settings")
            .onAppear { loadSettings() }
        }
    }

    private func loadSettings() {
        apiBaseURL = store.apiBaseURL
        apiKey = store.apiKey
        model = store.model
        autoInsert = store.autoInsert
    }

    private func saveSettings() {
        store.apiBaseURL = apiBaseURL.isEmpty ? AppGroupConfig.defaultAPIBaseURL : apiBaseURL
        store.apiKey = apiKey
        store.model = model
        store.autoInsert = autoInsert

        showSaved = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            showSaved = false
        }
    }
}
