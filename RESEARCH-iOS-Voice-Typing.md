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

**IMPORTANT CORRECTION**: iOS keyboard extensions **CANNOT directly access the microphone**. This restriction has been in place since iOS 8 and **remains in effect as of iOS 18+/2026**. Even with "Allow Full Access" / `RequestsOpenAccess`, `AVAudioSession` calls in the keyboard extension get permission errors.

**How voice-typing keyboard apps actually work around this:**

1. The keyboard extension shows a **mic button**
2. Tapping it **opens the containing (main) app** via a URL scheme
3. The **main app** records audio and runs transcription (cloud or on-device)
4. Transcribed text is written to a **shared App Group container** (`UserDefaults(suiteName:)` or shared file)
5. User switches back to the keyboard, which **reads the transcription and inserts it** via `textDocumentProxy.insertText()`

**How specific apps handle this:**

- **Wispr Flow** ([setup guide](https://docs.wisprflow.ai/articles/7453988911-set-up-the-flow-keyboard-on-iphone)): Tapping "Start Flow" opens the main app which starts a **persistent background audio session**, then returns you to your original app. The main app stays alive in the background with an active mic (configurable: 5 min, 15 min, 1 hour, or indefinite). Subsequent dictation doesn't require app switching. While Flow has the mic, Siri is unavailable.
- **KeyboardKit Pro v10.2+** (Jan 2026): "In-keyboard dictation" only requires opening the main app **once** to establish the audio session — subsequent dictation happens without app switching.
- **Typeless**: Similar — keyboard UI triggers main app for cloud-based voice processing.

### Open-Source Reference: WhisperBoard

[**WhisperBoard**](https://github.com/fmachta/WhisperBoard) by fmachta — open-source iOS app implementing exactly this pattern with WhisperKit:

- **Keyboard Extension** (`KeyboardViewController.swift`): Minimal UI with mic button. Does **zero** audio recording. On mic tap: sets a flag in shared `UserDefaults` (App Group), posts a **Darwin notification** (`com.fmachta.whisperboard.startRecording`), then polls the shared container every 0.5s for a result.
- **Main App** (`TranscriptionService.swift` + `AudioCapture.swift`): Listens for Darwin notification, records via `AVAudioEngine` (16kHz mono PCM), transcribes with **WhisperKit** (Core ML), writes result to shared container, posts Darwin notification back.
- **IPC**: App Groups for data exchange, Darwin notifications (`CFNotificationCenter`) for cross-process signaling.
- **Info.plist**: `RequestsOpenAccess = true` in keyboard extension, `NSMicrophoneUsageDescription` in main app only.

**This is the closest open-source reference to what you need to build.**

### Architecture Options

#### Option A: Keyboard Extension + Main App for Recording (How real apps do it)
```
┌─────────────────────────────────────────────────────┐
│  Custom Keyboard Extension                          │
│  ┌─────────┐                                        │
│  │ Mic     │── tap ──→ opens main app via URL scheme│
│  │ Button  │                                        │
│  └─────────┘                                        │
│                                                     │
│  ← reads transcription from shared App Group ──┐    │
│  → inserts via textDocumentProxy.insertText()  │    │
└────────────────────────────────────────────────┼────┘
                                                 │
┌────────────────────────────────────────────────┼────┐
│  Main App (containing app)                     │    │
│  ┌────────────────┐  ┌──────────────────────┐  │    │
│  │ Record Audio   │→ │ Transcribe           │  │    │
│  │ (AVAudioEngine)│  │ (Cloud API or        │──┘    │
│  │                │  │  on-device Whisper)   │       │
│  └────────────────┘  └──────────────────────┘       │
│                                                     │
│  Writes result to shared App Group container        │
└─────────────────────────────────────────────────────┘
```
**Pros**: Works within Apple's rules, can use full device resources for transcription
**Cons**: Requires app switch (brief UX friction), user must return to keyboard after recording

#### Option B: Standalone App + Clipboard (simplest approach)
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
**Pros**: No keyboard extension complexity, full device resources, simplest to build
**Cons**: Not seamless — user must switch apps and paste

#### Option C: Hybrid (RECOMMENDED for your use case)
Build both:
- **Phase 1**: Standalone app with record → transcribe → copy to clipboard
- **Phase 2**: Add keyboard extension with mic button that opens main app for recording, then auto-inserts transcribed text

---

## On-Device Whisper Options for iOS

### WhisperKit (RECOMMENDED)
[WhisperKit by Argmax](https://github.com/argmaxinc/WhisperKit) — the most mature Swift-native solution, presented at ICML 2025.

- **Integration**: Swift Package Manager, Xcode 16+, iOS 15+
- **Performance**: 0.45s mean latency for streaming, 2.2% WER with Large v3 Turbo
- **Models**: Pre-converted Core ML models on HuggingFace (tiny ~30MB to large-v3 ~1.5GB)
- **Custom models**: The `whisperkittools` companion repo lets you **convert your own fine-tuned Yiddish Whisper model to Core ML format** — this is critical for your use case
- **Streaming**: Yes, real-time with VAD and word timestamps

```swift
import WhisperKit
let pipe = try await WhisperKit()
let result = try await pipe.transcribe(audioPath: "audio.wav")
```

### whisper.cpp
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) — C/C++ port with XCFramework available via SPM.

- ARM NEON + Accelerate framework + Metal GPU + optional Core ML encoder
- Has built-in VAD
- iOS example exists (Objective-C), demonstrated on iPhone 13 fully offline
- Core ML gives 3x speedup on Apple Neural Engine
- More manual integration than WhisperKit

### SwiftWhisper
Swift wrapper around whisper.cpp. Simpler API. Core ML support. Good [Medium tutorial](https://medium.com/@jonataneduard/building-a-real-time-on-device-speech-to-text-in-swiftui-with-whisper-core-ml-ios-17-b1d468e44f4d) available.

### Apple's SpeechAnalyzer (iOS 26+, WWDC 2025)
Apple's new on-device speech framework. Fast (~45s for 34min audio), auto language detection. **Does NOT support Yiddish** — only ~60 languages. Not viable for your primary use case but could serve as English/Hebrew fallback.

---

## Recommended Implementation Plan

### Phase 1: iOS App with Cloud Transcription
Build a native Swift iOS app with:

1. **Main App**:
   - Audio recording with `AVAudioEngine`
   - Send audio to your existing KohnAI API (`https://api.kohnai.ai/v1/transcribe`)
   - Display transcription, copy to clipboard
   - Settings (API key, language, model selection)
   - Transcription history
   - Handle incoming URL scheme requests from keyboard extension

2. **Custom Keyboard Extension**:
   - Yiddish keyboard layout (Hebrew script characters)
   - Mic button that opens main app via URL scheme for recording
   - Reads transcription from shared App Group container
   - Inserts result via `textDocumentProxy.insertText()`
   - Requires "Allow Full Access" for network access to shared container

### Phase 2: On-Device Whisper
Add offline capability using WhisperKit:

1. Convert your fine-tuned Yiddish Whisper model to Core ML using `whisperkittools`
2. Bundle or download on first launch (use On-Demand Resources for App Store size)
3. Use Core ML acceleration on Apple Neural Engine
4. Fall back to cloud when higher accuracy needed or offline model confidence is low

### Phase 3: AI Text Cleanup (Typeless-like features)
- Send transcription through LLM API for filler word removal, grammar cleanup
- Tone adaptation based on target app context
- Translation support

### Key Technologies

| Component | Technology |
|-----------|-----------|
| Language | Swift / SwiftUI |
| Audio Recording | AVAudioEngine |
| Cloud Transcription | URLSession → KohnAI API |
| On-Device Transcription | WhisperKit (preferred) or whisper.cpp with Core ML |
| Keyboard Extension | UIInputViewController + textDocumentProxy |
| Keyboard Framework | KeyboardKit (optional, simplifies keyboard UI) |
| Shared Data | App Groups + UserDefaults(suiteName:) |
| Text Cleanup (optional) | LLM API for filler removal / formatting |

### Xcode Project Structure
```
YiddishVoice/
├── YiddishVoice/                     # Main app target
│   ├── App.swift
│   ├── ContentView.swift
│   ├── AudioRecorder.swift           # AVAudioEngine recording
│   ├── TranscriptionService.swift    # Cloud API client (KohnAI)
│   ├── WhisperService.swift          # On-device WhisperKit
│   ├── URLSchemeHandler.swift        # Handle keyboard → app flow
│   ├── HistoryView.swift
│   └── SettingsView.swift
├── YiddishVoiceKeyboard/             # Keyboard extension target
│   ├── KeyboardViewController.swift  # UIInputViewController
│   ├── KeyboardView.swift            # SwiftUI keyboard layout
│   ├── DictationHandler.swift        # Open main app + read result
│   └── Info.plist                    # RequestsOpenAccess = true
├── Shared/                           # Shared framework (App Group)
│   ├── APIClient.swift               # KohnAI API calls
│   ├── SharedStore.swift             # App Group UserDefaults
│   └── Config.swift                  # Shared configuration
└── Models/                           # Whisper model files
    └── (downloaded on first launch via WhisperKit)
```

---

## Yiddish-Specific Considerations

- Whisper supports Yiddish (`yi`) but it's a **low-resource language** — accuracy is poor without fine-tuning. Your existing fine-tuned model on RunPod is essential.
- **No publicly available fine-tuned Yiddish Whisper model** for on-device use. You'd convert your own using `whisperkittools`.
- Yiddish uses **Hebrew script** — the keyboard extension needs a Hebrew-character layout (or Yiddish-specific YIVO layout).
- Apple's `SpeechAnalyzer` and `SFSpeechRecognizer` do **NOT support Yiddish**, making Whisper (cloud or on-device) the only viable STT engine.
- For Hebrew (related language), community fine-tuned models like [Ivrit.ai](https://github.com/ShmuelRonen/hebrew_whisper) have shown major accuracy improvements — similar to what you're already doing for Yiddish.

---

## App Store Considerations

1. **Privacy**: Must declare microphone usage (`NSMicrophoneUsageDescription`), network usage. Need a privacy policy explaining data handling for cloud transcription.
2. **Allow Full Access**: Users are often reluctant to grant this. App description should clearly explain why it's needed (shared data between keyboard and app).
3. **Keyboard Extension Review**: Apple scrutinizes these carefully. Must work for basic typing without Full Access. Voice features require Full Access.
4. **Model Size**: If bundling Whisper models, use App Thinning / On-Demand Resources. WhisperKit supports downloading models on first launch.
5. **Memory limit**: Keyboard extensions have ~70MB memory limit. On-device Whisper must run in the main app, not the extension.

---

## Comparison: Your Current Electron App vs. iOS

| Feature | Current (Electron/Windows) | iOS Version |
|---------|---------------------------|-------------|
| Global hotkey | Ctrl+Shift+Space | Keyboard extension mic button |
| Audio recording | MediaRecorder (browser) | AVAudioEngine (native) |
| Transcription | KohnAI API | KohnAI API (same backend!) |
| Auto-paste | PowerShell SendKeys | textDocumentProxy.insertText() |
| Overlay UI | Electron BrowserWindow | Keyboard extension UI |
| Settings | Electron settings window | SwiftUI settings in main app |
| History | JSON file | Core Data / UserDefaults |

**The good news**: Your backend API is already built. The iOS app is a new native frontend calling the same `https://api.kohnai.ai/v1/transcribe` endpoint. Your fine-tuned Yiddish model can also be converted for on-device use via WhisperKit.

---

## Sources

- [WhisperBoard - Open Source Reference (GitHub)](https://github.com/fmachta/WhisperBoard)
- [WhisperKit - GitHub (Argmax)](https://github.com/argmaxinc/WhisperKit)
- [whisper.cpp - GitHub](https://github.com/ggml-org/whisper.cpp)
- [WhisperKit Core ML Models - HuggingFace](https://huggingface.co/argmaxinc/whisperkit-coreml)
- [KeyboardKit - GitHub](https://github.com/KeyboardKit/KeyboardKit)
- [KeyboardKit: New Keyboard Dictation (Jan 2026)](https://keyboardkit.com/blog/2026/01/03/a-brand-new-keyboard-dictation-experience)
- [Apple Custom Keyboard Docs](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/CustomKeyboard.html)
- [Apple Developer Forums: Recording in Keyboard Extension](https://developer.apple.com/forums/thread/742601)
- [Apple Developer Forums: AVAudioSession error in keyboard](https://developer.apple.com/forums/thread/709107)
- [Wispr Flow iOS Setup Guide](https://docs.wisprflow.ai/articles/7453988911-set-up-the-flow-keyboard-on-iphone)
- [Swift Forums: How voice dictation keyboards return to previous app](https://forums.swift.org/t/how-do-voice-dictation-keyboard-apps-like-wispr-flow-return-users-to-the-previous-app-automatically/83988)
- [SpeechAnalyzer - Apple Developer Docs](https://developer.apple.com/documentation/speech/speechanalyzer)
- [Building Real-Time On-Device STT in SwiftUI (Medium)](https://medium.com/@jonataneduard/building-a-real-time-on-device-speech-to-text-in-swiftui-with-whisper-core-ml-ios-17-b1d468e44f4d)
- [Typeless Official Website](https://www.typeless.com/)
- [Whisper Flow (whisperflow.app)](https://whisperflow.app/)
- [Whisperflow.de](https://www.whisperflow.de/)
