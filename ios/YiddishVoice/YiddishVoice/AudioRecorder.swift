import AVFoundation
import Foundation

/// Records audio using AVAudioEngine and produces WAV data suitable for the KohnAI API.
final class AudioRecorder: NSObject, ObservableObject {
    @Published var isRecording = false
    @Published var audioLevel: Float = 0.0

    private var audioEngine: AVAudioEngine?
    private var audioData = Data()
    private let sampleRate: Double = 16000.0

    /// Request microphone permission.
    func requestPermission(completion: @escaping (Bool) -> Void) {
        AVAudioApplication.requestRecordPermission { granted in
            DispatchQueue.main.async {
                completion(granted)
            }
        }
    }

    /// Start recording audio. Audio is accumulated in memory as PCM data.
    func startRecording() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)

        audioEngine = AVAudioEngine()
        guard let audioEngine = audioEngine else { return }

        let inputNode = audioEngine.inputNode
        let recordingFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!

        audioData = Data()

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            guard let self = self else { return }

            // Calculate audio level for visual feedback
            let channelData = buffer.floatChannelData?[0]
            let frameLength = Int(buffer.frameLength)
            var sum: Float = 0
            for i in 0..<frameLength {
                let sample = channelData?[i] ?? 0
                sum += sample * sample
            }
            let rms = sqrtf(sum / Float(frameLength))
            DispatchQueue.main.async {
                self.audioLevel = rms
            }

            // Accumulate PCM data
            let data = Data(bytes: channelData!, count: frameLength * MemoryLayout<Float>.size)
            DispatchQueue.main.async {
                self.audioData.append(data)
            }
        }

        audioEngine.prepare()
        try audioEngine.start()

        DispatchQueue.main.async {
            self.isRecording = true
        }
    }

    /// Stop recording and return the audio as WAV data.
    func stopRecording() -> Data? {
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil

        DispatchQueue.main.async {
            self.isRecording = false
            self.audioLevel = 0
        }

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

        guard !audioData.isEmpty else { return nil }
        return createWAV(from: audioData)
    }

    /// Convert raw PCM float data to a WAV file.
    private func createWAV(from pcmData: Data) -> Data {
        // Convert Float32 PCM to Int16 PCM for WAV
        let floatCount = pcmData.count / MemoryLayout<Float>.size
        var int16Data = Data(capacity: floatCount * MemoryLayout<Int16>.size)

        pcmData.withUnsafeBytes { rawBuffer in
            let floats = rawBuffer.bindMemory(to: Float.self)
            for i in 0..<floatCount {
                let clamped = max(-1.0, min(1.0, floats[i]))
                var int16 = Int16(clamped * Float(Int16.max))
                int16Data.append(Data(bytes: &int16, count: MemoryLayout<Int16>.size))
            }
        }

        let numChannels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let byteRate = UInt32(sampleRate) * UInt32(numChannels) * UInt32(bitsPerSample / 8)
        let blockAlign = numChannels * (bitsPerSample / 8)
        let dataSize = UInt32(int16Data.count)
        let fileSize = 36 + dataSize

        var header = Data()
        header.append(contentsOf: "RIFF".utf8)
        header.append(littleEndian: fileSize)
        header.append(contentsOf: "WAVE".utf8)
        header.append(contentsOf: "fmt ".utf8)
        header.append(littleEndian: UInt32(16)) // chunk size
        header.append(littleEndian: UInt16(1))  // PCM format
        header.append(littleEndian: numChannels)
        header.append(littleEndian: UInt32(sampleRate))
        header.append(littleEndian: byteRate)
        header.append(littleEndian: blockAlign)
        header.append(littleEndian: bitsPerSample)
        header.append(contentsOf: "data".utf8)
        header.append(littleEndian: dataSize)

        return header + int16Data
    }
}

private extension Data {
    mutating func append(littleEndian value: UInt16) {
        var v = value.littleEndian
        append(Data(bytes: &v, count: 2))
    }

    mutating func append(littleEndian value: UInt32) {
        var v = value.littleEndian
        append(Data(bytes: &v, count: 4))
    }
}
