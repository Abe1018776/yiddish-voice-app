# Yiddish Voice - iOS App

A Yiddish speech-to-text iOS app with a custom keyboard extension. Tap the mic, speak in Yiddish, and get transcribed text inserted into any app.

## Architecture

The app has two targets that communicate via App Groups and Darwin notifications:

```
Main App (YiddishVoice)           Keyboard Extension (YiddishVoiceKeyboard)
├── Records audio (AVAudioEngine)  ├── Shows mic button + basic keys
├── Sends to KohnAI API            ├── Signals main app to record
├── On-device Whisper (future)     ├── Reads transcription result
├── History & Settings             └── Inserts text via textDocumentProxy
└── Writes result to App Group
```

**Why this split?** iOS keyboard extensions cannot access the microphone. The keyboard signals the main app (which can), then reads the result from shared storage.

## Setup

### Prerequisites
- macOS with Xcode 15+
- An Apple Developer account (for App Groups capability)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (recommended)

### Generate the Xcode project

```bash
cd ios/YiddishVoice

# Install XcodeGen if needed
brew install xcodegen

# Generate .xcodeproj from project.yml
xcodegen generate

# Open in Xcode
open YiddishVoice.xcodeproj
```

### Configure signing
1. Open the project in Xcode
2. Select the **YiddishVoice** target > Signing & Capabilities
3. Set your Team and Bundle Identifier (`com.yiddishvoice.app`)
4. Ensure **App Groups** capability is added with `group.com.yiddishvoice.shared`
5. Do the same for **YiddishVoiceKeyboard** target (`com.yiddishvoice.app.keyboard`)

### Build & Run
1. Select an iPhone simulator or device
2. Build and run the **YiddishVoice** scheme
3. On device, go to Settings > General > Keyboard > Keyboards > Add New Keyboard
4. Select "Yiddish Voice"
5. Enable "Allow Full Access" (required for shared data between app and keyboard)

## How It Works

### Recording Flow
1. User taps mic button in the keyboard extension
2. Keyboard posts a Darwin notification + opens the main app via URL scheme (`yiddishvoice://record`)
3. Main app records audio via `AVAudioEngine` (16kHz mono PCM)
4. Audio is converted to WAV and sent to the KohnAI API (`/v1/transcribe`)
5. Transcription result is written to the App Group shared container
6. Main app posts a Darwin notification back to the keyboard
7. Keyboard reads the result and inserts it via `textDocumentProxy.insertText()`

### API
Uses the same KohnAI ASR API as the desktop Electron app:
- Endpoint: `https://api.kohnai.ai/v1/transcribe`
- Payload: `{ audio: "<base64>", model: "gemini", language: "yi" }`
- Auth: `Bearer <api-key>` header

### Shared Code (App Group IPC)
- `AppGroupConfig.swift` — Constants (suite name, notification names, keys)
- `DarwinNotificationCenter.swift` — Cross-process notifications via CFNotificationCenter
- `SharedStore.swift` — Read/write shared UserDefaults
- `KohnAIClient.swift` — API client for transcription

## Future Enhancements
- **On-device Whisper** via WhisperKit (convert your fine-tuned Yiddish model with `whisperkittools`)
- **Background audio session** (Wispr Flow pattern) so subsequent dictation doesn't require app switching
- **Yiddish character keyboard** layout alongside the voice input
- **LLM text cleanup** for filler word removal and formatting
