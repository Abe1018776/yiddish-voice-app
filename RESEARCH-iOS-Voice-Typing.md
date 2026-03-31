# Research: Building an iOS Voice Typing App (like Typeless / WhisperFlow)

## What These Apps Do

### Typeless
- **Platforms**: iOS, macOS, Windows, Android
- **iOS integration**: Custom keyboard extension (Settings > Keyboards)
- **How it works**: Hybrid cloud + on-device. Requires internet. Voice data sent to servers with "zero data retention". Uses LLM post-processing for smart cleanup (filler word removal, auto-formatting, tone adaptation).
- **Pricing**: Free (8,000 words/week) / Pro $12/mo yearly
- **Key differentiator**: AI-powered cleanup — removes "um", "uh", self-corrections. Context-aware tone (formal for email, casual for chat). Translation. 100+ languages.

### WhisperFlow (multiple products with this name)

**1. Butterfly AI's "Whisper Flow" (whisperflow.app / App Store)**
- iOS keyboard extension, also macOS/Windows/Android
- Uses **Gemini 4 AI** (cloud-based, NOT actually OpenAI Whisper despite the name)
- Free 1,000 words/week, premium $39.99/year
- Features: grammar correction, 5 rephrasing tones, translation

**2. Whisperflow.de (macOS only)**
- Uses actual **whisper.cpp** — 100% on-device, zero cloud
- Free / open source, macOS only
- 2.5 MB, extremely lightweight

---

## How to Build This for iOS: Technical Architecture

### The Core Challenge: iOS Keyboard Extensions + Microphone

**Critical finding**: Apple's original iOS 8 documentation stated keyboard extensions have "no access to the device microphone." However, **starting around iOS 10+**, Apple relaxed this restriction:

- With **"Allow Full Access"** enabled (user must grant this in Settings), keyboard extensions gain expanded capabilities including **network access** and access to shared containers with the containing app.
- **Microphone access for keyboard extensions** requires:
  1. `RequestsOpenAccess` set to `true` in the extension's `Info.plist`
  2. User enabling "Allow Full Access" in Settings
  3. `NSMicrophoneUsageDescription` in the containing app's `Info.plist`
  4. The user granting microphone permission when prompted

Apps like Typeless confirm this works — they are listed as keyboard extensions on the App Store and provide voice input.

### Architecture Options

#### Option A: Keyboard Extension with Cloud Transcription (Typeless approach)
```
┌─────────────────────────────────────┐
│  iOS Custom Keyboard Extension      │
│  ┌─────────┐  ┌──────────────────┐  │
│  │ Mic     │→ │ Audio Recording   │  │
│  │ Button  │  │ (AVAudioEngine)   │  │
│  └─────────┘  └────────┬─────────┘  │
│                         │            │
│              ┌──────────▼─────────┐  │
│              │ Send to Cloud API  │  │
│              │ (your KohnAI API)  │  │
│              └──────────┬─────────┘  │
│                         │            │
│              ┌──────────▼─────────┐  │
│              │ Insert text via    │  │
│              │ textDocumentProxy  │  │
│              └────────────────────┘  │
└─────────────────────────────────────┘
```
**Pros**: Small app size, best accuracy, can use your existing KohnAI API
**Cons**: Requires internet, latency, ongoing server costs

#### Option B: Keyboard Extension with On-Device Whisper (whisperflow.de approach)
```
┌─────────────────────────────────────┐
│  iOS Custom Keyboard Extension      │
│  ┌─────────┐  ┌──────────────────┐  │
│  │ Mic     │→ │ Audio Recording   │  │
│  │ Button  │  │ (AVAudioEngine)   │  │
│  └─────────┘  └────────┬─────────┘  │
│                         │            │
│              ┌──────────▼─────────┐  │
│              │ whisper.cpp +      │  │
│              │ Core ML (on-device)│  │
│              └──────────┬─────────┘  │
│                         │            │
│              ┌──────────▼─────────┐  │
│              │ Insert text via    │  │
│              │ textDocumentProxy  │  │
│              └────────────────────┘  │
└─────────────────────────────────────┘
```
**Pros**: Works offline, no server costs, fast, private
**Cons**: Larger app size (~40-150MB for model), less accurate for Yiddish without fine-tuned model, limited by device RAM (keyboard extensions have ~50MB memory limit — this is a real constraint)

#### Option C: Companion App + Clipboard (workaround approach)
```
┌─────────────────────┐    ┌─────────────────────┐
│  Main App            │    │  Any App (Messages)  │
│  ┌────────────────┐  │    │                      │
│  │ Record Audio   │  │    │  User pastes from    │
│  │ Transcribe     │  │    │  clipboard           │
│  │ Copy to        │  │    │                      │
│  │ Clipboard      │  │    │                      │
│  └────────────────┘  │    └──────────────────────┘
└─────────────────────┘
```
**Pros**: No keyboard extension restrictions, full device resources
**Cons**: Not seamless — user must switch apps and paste

#### Option D: Hybrid (RECOMMENDED for your use case)
Keyboard extension for quick voice input (cloud API), plus a standalone app for longer transcriptions with on-device Whisper.

---

## Recommended Implementation Plan

### Phase 1: iOS App with Cloud Transcription
Build a native Swift iOS app with:

1. **Containing App** (main app):
   - Audio recording with `AVAudioEngine`
   - Send audio to your existing KohnAI API (`https://api.kohnai.ai/v1/transcribe`)
   - Display transcription, copy to clipboard
   - Settings (API key, language, model selection)
   - Transcription history

2. **Custom Keyboard Extension**:
   - Mic button on the keyboard
   - Record audio when held/tapped
   - Send to KohnAI API for transcription
   - Insert result via `textDocumentProxy.insertText()`
   - Requires "Allow Full Access" for network + mic

### Phase 2: On-Device Whisper (Optional)
Add offline capability using whisper.cpp:

1. Bundle a Whisper model (tiny or base for keyboard, larger for main app)
2. Use Core ML acceleration for 3x speed on Apple Neural Engine
3. Fall back to cloud when higher accuracy needed

### Key Technologies

| Component | Technology |
|-----------|-----------|
| Language | Swift / SwiftUI |
| Audio Recording | AVAudioEngine / AVAudioRecorder |
| Cloud Transcription | URLSession → KohnAI API |
| On-Device Transcription | whisper.cpp with Core ML |
| Keyboard Extension | UIInputViewController + textDocumentProxy |
| Text Cleanup (optional) | Send to LLM API for filler removal |

### Key Libraries / Dependencies

- **whisper.cpp** — `github.com/ggerganov/whisper.cpp` (C/C++, has iOS example in Obj-C)
  - Core ML support for 3x speed on Apple Neural Engine
  - Runs fully on-device on iPhone
  - Demonstrated working on iPhone 13
- **WhisperKit** — `github.com/argmaxinc/WhisperKit` (pure Swift wrapper, optimized for Apple)
  - Native Swift API, easier to integrate than raw whisper.cpp
  - Core ML optimized
  - Supports all Whisper model sizes
- **Swift Package Manager** for dependencies

### Memory Constraints for Keyboard Extension

Keyboard extensions have a ~50MB memory limit (can vary by device). This means:
- **Whisper tiny** (~75MB model) may be tight but possible with quantization
- **Whisper base** (~150MB model) likely too large for the extension
- **Cloud API** is the safer bet for the keyboard extension
- Use on-device Whisper in the **main app** where you have full resources

### Xcode Project Structure
```
YiddishVoice/
├── YiddishVoice/                    # Main app target
│   ├── App.swift
│   ├── ContentView.swift
│   ├── AudioRecorder.swift          # AVAudioEngine recording
│   ├── TranscriptionService.swift   # Cloud API client
│   ├── WhisperService.swift         # On-device whisper.cpp
│   ├── HistoryView.swift
│   └── SettingsView.swift
├── YiddishVoiceKeyboard/            # Keyboard extension target
│   ├── KeyboardViewController.swift # UIInputViewController
│   ├── KeyboardView.swift           # SwiftUI keyboard layout
│   ├── AudioRecorder.swift          # Shared recording logic
│   └── Info.plist                   # RequestsOpenAccess = true
├── Shared/                          # Shared framework
│   ├── APIClient.swift              # KohnAI API calls
│   └── Config.swift                 # Shared configuration
└── Models/                          # Whisper model files
    └── ggml-tiny.bin
```

---

## App Store Considerations

1. **Privacy**: Must declare microphone usage, network usage. If using cloud transcription, need a privacy policy explaining data handling.
2. **Allow Full Access**: Users are often reluctant to grant "Allow Full Access" to keyboards. Your app description should clearly explain why it's needed (microphone for voice input, network for transcription).
3. **Keyboard Extension Review**: Apple reviews keyboard extensions carefully. Ensure you're not logging keystrokes or sending data you shouldn't.
4. **Model Size**: If bundling Whisper models, the app will be larger. Use App Thinning / On-Demand Resources to manage this.

---

## Comparison: Your Current Electron App vs. iOS

| Feature | Current (Electron/Windows) | iOS Version |
|---------|---------------------------|-------------|
| Global hotkey | Ctrl+Shift+Space | Keyboard extension mic button |
| Audio recording | MediaRecorder (browser) | AVAudioEngine (native) |
| Transcription | KohnAI API | KohnAI API (same!) |
| Auto-paste | PowerShell SendKeys | textDocumentProxy.insertText() |
| Overlay UI | Electron BrowserWindow | Keyboard extension UI |
| Settings | Electron settings window | SwiftUI settings in main app |
| History | JSON file | Core Data / UserDefaults |

The good news: your backend API is already built. The iOS app just needs to be a new frontend that calls the same `https://api.kohnai.ai/v1/transcribe` endpoint.
