import Foundation

/// API client for the KohnAI ASR transcription service.
/// Mirrors the Electron app's transcription.js — sends base64 audio to /v1/transcribe.
final class KohnAIClient {

    struct TranscriptionResponse: Decodable {
        let text: String?
        let error: String?
    }

    /// Transcribe audio data by sending it to the KohnAI API.
    /// - Parameters:
    ///   - audioData: Raw audio data (WAV format preferred)
    ///   - completion: Called on main thread with result or error
    func transcribe(audioData: Data, completion: @escaping (Result<String, Error>) -> Void) {
        let store = SharedStore.shared
        let baseURL = store.apiBaseURL
        let apiKey = store.apiKey
        let model = store.model

        guard let url = URL(string: "\(baseURL)/v1/transcribe") else {
            completion(.failure(APIError.invalidURL))
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !apiKey.isEmpty {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
        request.timeoutInterval = 30

        let base64Audio = audioData.base64EncodedString()
        let body: [String: Any] = [
            "audio": base64Audio,
            "model": model,
            "language": "yi"
        ]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        } catch {
            completion(.failure(error))
            return
        }

        URLSession.shared.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    completion(.failure(error))
                    return
                }

                guard let data = data else {
                    completion(.failure(APIError.noData))
                    return
                }

                do {
                    let decoded = try JSONDecoder().decode(TranscriptionResponse.self, from: data)
                    if let errorMsg = decoded.error {
                        completion(.failure(APIError.serverError(errorMsg)))
                    } else if let text = decoded.text, !text.isEmpty {
                        completion(.success(text))
                    } else {
                        completion(.failure(APIError.emptyTranscription))
                    }
                } catch {
                    // Try to read raw text response
                    if let text = String(data: data, encoding: .utf8), !text.isEmpty {
                        completion(.success(text))
                    } else {
                        completion(.failure(error))
                    }
                }
            }
        }.resume()
    }

    enum APIError: LocalizedError {
        case invalidURL
        case noData
        case emptyTranscription
        case serverError(String)

        var errorDescription: String? {
            switch self {
            case .invalidURL: return "Invalid API URL"
            case .noData: return "No data received from server"
            case .emptyTranscription: return "Empty transcription result"
            case .serverError(let msg): return "Server error: \(msg)"
            }
        }
    }
}
