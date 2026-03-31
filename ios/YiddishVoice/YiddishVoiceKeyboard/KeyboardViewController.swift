import UIKit

/// Custom keyboard extension for Yiddish voice input.
/// This extension CANNOT record audio directly (iOS restriction).
/// Instead, it signals the main app to record via Darwin notifications,
/// then reads the transcription result from the shared App Group container.
class KeyboardViewController: UIInputViewController {

    private var micButton: UIButton!
    private var globeButton: UIButton!
    private var statusLabel: UILabel!
    private var containerView: UIView!
    private var pollingTimer: Timer?
    private var isWaitingForTranscription = false

    private let store = SharedStore.shared

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
        setupDarwinObserver()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        pollingTimer?.invalidate()
        pollingTimer = nil
    }

    // MARK: - UI Setup

    private func setupUI() {
        containerView = UIView()
        containerView.translatesAutoresizingMaskIntoConstraints = false
        containerView.backgroundColor = UIColor.systemBackground
        view.addSubview(containerView)

        NSLayoutConstraint.activate([
            containerView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            containerView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            containerView.topAnchor.constraint(equalTo: view.topAnchor),
            containerView.heightAnchor.constraint(equalToConstant: 260)
        ])

        // Top bar with globe and status
        let topBar = UIStackView()
        topBar.axis = .horizontal
        topBar.spacing = 12
        topBar.alignment = .center
        topBar.translatesAutoresizingMaskIntoConstraints = false
        containerView.addSubview(topBar)

        // Globe button (switch keyboard)
        globeButton = UIButton(type: .system)
        globeButton.setImage(UIImage(systemName: "globe"), for: .normal)
        globeButton.tintColor = .label
        globeButton.addTarget(self, action: #selector(handleGlobeTap), for: .touchUpInside)
        globeButton.widthAnchor.constraint(equalToConstant: 44).isActive = true
        globeButton.heightAnchor.constraint(equalToConstant: 44).isActive = true
        topBar.addArrangedSubview(globeButton)

        // Status label
        statusLabel = UILabel()
        statusLabel.text = "Tap mic to dictate in Yiddish"
        statusLabel.font = .systemFont(ofSize: 14)
        statusLabel.textColor = .secondaryLabel
        statusLabel.textAlignment = .center
        topBar.addArrangedSubview(statusLabel)

        // Spacer
        let spacer = UIView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        topBar.addArrangedSubview(spacer)

        NSLayoutConstraint.activate([
            topBar.leadingAnchor.constraint(equalTo: containerView.leadingAnchor, constant: 8),
            topBar.trailingAnchor.constraint(equalTo: containerView.trailingAnchor, constant: -8),
            topBar.topAnchor.constraint(equalTo: containerView.topAnchor, constant: 8),
            topBar.heightAnchor.constraint(equalToConstant: 44)
        ])

        // Mic button (center)
        micButton = UIButton(type: .system)
        micButton.translatesAutoresizingMaskIntoConstraints = false
        let micConfig = UIImage.SymbolConfiguration(pointSize: 36, weight: .medium)
        micButton.setImage(UIImage(systemName: "mic.fill", withConfiguration: micConfig), for: .normal)
        micButton.tintColor = .white
        micButton.backgroundColor = .systemBlue
        micButton.layer.cornerRadius = 40
        micButton.clipsToBounds = true
        micButton.addTarget(self, action: #selector(handleMicTap), for: .touchUpInside)
        containerView.addSubview(micButton)

        NSLayoutConstraint.activate([
            micButton.centerXAnchor.constraint(equalTo: containerView.centerXAnchor),
            micButton.centerYAnchor.constraint(equalTo: containerView.centerYAnchor, constant: 10),
            micButton.widthAnchor.constraint(equalToConstant: 80),
            micButton.heightAnchor.constraint(equalToConstant: 80)
        ])

        // Bottom row: backspace, space, return
        let bottomBar = UIStackView()
        bottomBar.axis = .horizontal
        bottomBar.spacing = 8
        bottomBar.distribution = .fillEqually
        bottomBar.translatesAutoresizingMaskIntoConstraints = false
        containerView.addSubview(bottomBar)

        let backspaceBtn = makeBottomButton(title: nil, systemImage: "delete.left", action: #selector(handleBackspace))
        let spaceBtn = makeBottomButton(title: "space", systemImage: nil, action: #selector(handleSpace))
        let returnBtn = makeBottomButton(title: "return", systemImage: nil, action: #selector(handleReturn))

        bottomBar.addArrangedSubview(backspaceBtn)
        bottomBar.addArrangedSubview(spaceBtn)
        bottomBar.addArrangedSubview(returnBtn)

        NSLayoutConstraint.activate([
            bottomBar.leadingAnchor.constraint(equalTo: containerView.leadingAnchor, constant: 8),
            bottomBar.trailingAnchor.constraint(equalTo: containerView.trailingAnchor, constant: -8),
            bottomBar.bottomAnchor.constraint(equalTo: containerView.bottomAnchor, constant: -8),
            bottomBar.heightAnchor.constraint(equalToConstant: 44)
        ])
    }

    private func makeBottomButton(title: String?, systemImage: String?, action: Selector) -> UIButton {
        let btn = UIButton(type: .system)
        if let systemImage = systemImage {
            btn.setImage(UIImage(systemName: systemImage), for: .normal)
        }
        if let title = title {
            btn.setTitle(title, for: .normal)
        }
        btn.backgroundColor = UIColor.systemGray5
        btn.layer.cornerRadius = 8
        btn.tintColor = .label
        btn.addTarget(self, action: action, for: .touchUpInside)
        return btn
    }

    // MARK: - Darwin Notification Observer

    private func setupDarwinObserver() {
        DarwinNotificationCenter.shared.observe(name: AppGroupConfig.transcriptionReadyNotification) { [weak self] in
            DispatchQueue.main.async {
                self?.handleTranscriptionReady()
            }
        }
    }

    // MARK: - Actions

    @objc private func handleGlobeTap() {
        advanceToNextInputMode()
    }

    @objc private func handleMicTap() {
        if isWaitingForTranscription {
            // Already waiting, signal stop
            DarwinNotificationCenter.shared.post(name: AppGroupConfig.stopRecordingNotification)
            statusLabel.text = "Transcribing..."
            micButton.backgroundColor = .systemOrange
            return
        }

        // Clear previous result
        store.transcriptionResult = nil
        store.transcriptionStatus = "idle"

        // Try Darwin notification first (if main app is running in background)
        store.recordingRequested = true
        DarwinNotificationCenter.shared.post(name: AppGroupConfig.startRecordingNotification)

        // Also open the main app via URL scheme as fallback
        if let url = URL(string: "\(AppGroupConfig.urlScheme)://\(AppGroupConfig.recordAction)") {
            openURL(url)
        }

        isWaitingForTranscription = true
        statusLabel.text = "Recording... tap to stop"
        micButton.backgroundColor = .systemRed
        let micConfig = UIImage.SymbolConfiguration(pointSize: 36, weight: .medium)
        micButton.setImage(UIImage(systemName: "stop.fill", withConfiguration: micConfig), for: .normal)

        // Start polling for result as backup to Darwin notification
        startPolling()
    }

    private func openURL(_ url: URL) {
        // Keyboard extensions can open URLs via the responder chain
        var responder: UIResponder? = self
        while let r = responder {
            if let application = r as? UIApplication {
                application.open(url, options: [:], completionHandler: nil)
                return
            }
            responder = r.next
        }
        // Alternative: use the selector-based approach
        let selector = NSSelectorFromString("openURL:")
        responder = self
        while let r = responder {
            if r.responds(to: selector) {
                r.perform(selector, with: url)
                return
            }
            responder = r.next
        }
    }

    @objc private func handleBackspace() {
        textDocumentProxy.deleteBackward()
    }

    @objc private func handleSpace() {
        textDocumentProxy.insertText(" ")
    }

    @objc private func handleReturn() {
        textDocumentProxy.insertText("\n")
    }

    // MARK: - Transcription Handling

    private func startPolling() {
        pollingTimer?.invalidate()
        pollingTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.checkForTranscription()
        }
    }

    private func checkForTranscription() {
        let status = store.transcriptionStatus
        switch status {
        case "ready":
            handleTranscriptionReady()
        case "recording":
            statusLabel.text = "Recording... tap to stop"
        case "transcribing":
            statusLabel.text = "Transcribing..."
            micButton.backgroundColor = .systemOrange
        case "error":
            resetUI()
            statusLabel.text = "Error. Tap to try again."
        default:
            break
        }
    }

    private func handleTranscriptionReady() {
        pollingTimer?.invalidate()
        pollingTimer = nil

        guard let text = store.transcriptionResult, !text.isEmpty else {
            resetUI()
            statusLabel.text = "No transcription received"
            return
        }

        // Insert the transcribed text into the current text field
        textDocumentProxy.insertText(text)

        // Clear the shared state
        store.transcriptionResult = nil
        store.transcriptionStatus = "idle"

        resetUI()
        statusLabel.text = "Inserted! Tap mic to dictate again"

        // Reset status message after a delay
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            if self?.statusLabel.text == "Inserted! Tap mic to dictate again" {
                self?.statusLabel.text = "Tap mic to dictate in Yiddish"
            }
        }
    }

    private func resetUI() {
        isWaitingForTranscription = false
        micButton.backgroundColor = .systemBlue
        let micConfig = UIImage.SymbolConfiguration(pointSize: 36, weight: .medium)
        micButton.setImage(UIImage(systemName: "mic.fill", withConfiguration: micConfig), for: .normal)
    }
}
