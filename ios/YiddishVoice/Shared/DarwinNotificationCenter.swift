import Foundation

/// Cross-process notification center using Darwin notifications (CFNotificationCenter).
/// This enables communication between the keyboard extension and the main app
/// since they run in separate processes and cannot use NotificationCenter.
final class DarwinNotificationCenter {
    static let shared = DarwinNotificationCenter()

    private var callbacks: [String: () -> Void] = [:]

    private init() {}

    /// Post a Darwin notification visible to all processes in the app group.
    func post(name: String) {
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterPostNotification(center, CFNotificationName(name as CFString), nil, nil, true)
    }

    /// Observe a Darwin notification. Only one callback per name is supported.
    func observe(name: String, callback: @escaping () -> Void) {
        callbacks[name] = callback

        let center = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterAddObserver(
            center,
            Unmanaged.passUnretained(self).toOpaque(),
            { _, observer, notificationName, _, _ in
                guard let observer = observer,
                      let name = notificationName?.rawValue as String? else { return }
                let center = Unmanaged<DarwinNotificationCenter>.fromOpaque(observer).takeUnretainedValue()
                center.callbacks[name]?()
            },
            name as CFString,
            nil,
            .deliverImmediately
        )
    }

    /// Remove observer for a specific notification name.
    func removeObserver(name: String) {
        callbacks.removeValue(forKey: name)
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterRemoveObserver(center, Unmanaged.passUnretained(self).toOpaque(), CFNotificationName(name as CFString), nil)
    }
}
