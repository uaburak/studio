import AVFoundation
import Foundation
import Observation
import Speech
import UIKit

// MARK: - Read aloud

/// Reads an assistant reply aloud with a Turkish voice; one message at a time.
@MainActor
@Observable
final class MessageSpeaker {
    static let shared = MessageSpeaker()

    /// The message being read, if any.
    private(set) var speakingId: String?
    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
    @ObservationIgnored private let delegate = SpeechDelegate()

    init() {
        delegate.onFinish = { [weak self] in self?.finished() }
        synthesizer.delegate = delegate
    }

    /// Start reading `text`, or stop when this message is already being read.
    func toggle(id: String, text: String) {
        if speakingId == id {
            stop()
            return
        }
        synthesizer.stopSpeaking(at: .immediate)
        let spoken = Self.speakable(text)
        guard !spoken.isEmpty else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
        let utterance = AVSpeechUtterance(string: spoken)
        utterance.voice = AVSpeechSynthesisVoice(language: "tr-TR")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        speakingId = id
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        finished()
    }

    private func finished() {
        guard speakingId != nil else { return }
        speakingId = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Markdown turned into plain sentences: no `**`, `#`, backticks, bullets or link targets.
    nonisolated static func speakable(_ markdown: String) -> String {
        var lines: [String] = []
        var inCode = false
        for raw in markdown.components(separatedBy: "\n") {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                inCode.toggle()
                continue
            }
            if inCode || line.isEmpty { continue }
            while line.hasPrefix("#") { line.removeFirst() }
            for bullet in ["- ", "* ", "• "] where line.hasPrefix(bullet) { line = String(line.dropFirst(bullet.count)) }
            line = line.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
            for mark in ["**", "__", "`", "*", "_"] { line = line.replacingOccurrences(of: mark, with: "") }
            line = line.trimmingCharacters(in: .whitespaces)
            if !line.isEmpty { lines.append(line) }
        }
        return lines.joined(separator: "\n")
    }
}

@MainActor
private final class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
    var onFinish: (() -> Void)?

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.onFinish?() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.onFinish?() }
    }
}

// MARK: - Dictation

/// Turkish speech-to-text for the composer (on device when the phone supports it).
@MainActor
@Observable
final class IOSDictation {
    enum State: Equatable { case idle, starting, listening }

    private(set) var state: State = .idle
    private(set) var transcript = ""
    /// Called with the whole transcript so far, on every partial result.
    @ObservationIgnored var onTranscript: ((String) -> Void)?
    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var recognizer: SFSpeechRecognizer?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?

    static let locale = Locale(identifier: "tr-TR")

    var isActive: Bool { state != .idle }

    /// Ask for the microphone and speech permissions and start listening.
    /// Returns a Turkish message when it cannot start.
    func start() async -> String? {
        guard state == .idle else { return nil }
        state = .starting
        transcript = ""
        guard await Self.speechPermission() else {
            state = .idle
            return "Dikte için konuşma tanıma izni gerekiyor (Ayarlar → Studio)."
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            state = .idle
            return "Dikte için mikrofon izni gerekiyor (Ayarlar → Studio)."
        }
        // Released (stopped) while the permission prompts were up.
        guard state == .starting else { return nil }
        guard let recognizer = SFSpeechRecognizer(locale: Self.locale), recognizer.isAvailable else {
            state = .idle
            return "Türkçe konuşma tanıma şu an kullanılamıyor."
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.addsPunctuation = true
            if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
            let engine = AVAudioEngine()
            let input = engine.inputNode
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0), block: Self.tapBlock(request))
            engine.prepare()
            try engine.start()
            self.engine = engine
            self.request = request
            self.recognizer = recognizer
            self.task = recognizer.recognitionTask(with: request, resultHandler: Self.resultHandler(DictationRef(self)))
            state = .listening
            return nil
        } catch {
            teardown()
            return "Mikrofon başlatılamadı."
        }
    }

    /// Stop listening and wait (briefly) for the final transcript.
    func stop() async {
        switch state {
        case .idle:
            return
        case .starting:
            state = .idle
            return
        case .listening:
            engine?.stop()
            engine?.inputNode.removeTap(onBus: 0)
            engine = nil
            request?.endAudio()
            for _ in 0..<15 where task != nil {
                try? await Task.sleep(for: .milliseconds(100))
            }
            teardown()
        }
    }

    fileprivate func received(text: String?, isFinal: Bool, failed: Bool) {
        if let text, state != .idle {
            transcript = text
            onTranscript?(text)
        }
        if isFinal || failed { teardown() }
    }

    private func teardown() {
        if let engine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        engine = nil
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        if state != .idle {
            state = .idle
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    // The audio tap and the recognizer call back off the main thread: build those closures
    // outside the main actor and hop back explicitly.

    nonisolated private static func tapBlock(_ request: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
        nonisolated(unsafe) let request = request
        return { buffer, _ in request.append(buffer) }
    }

    nonisolated private static func resultHandler(_ ref: DictationRef) -> @Sendable (SFSpeechRecognitionResult?, (any Error)?) -> Void {
        { result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor in ref.value?.received(text: text, isFinal: isFinal, failed: failed) }
        }
    }

    nonisolated private static func speechPermission() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
            }
        default:
            return false
        }
    }
}

private final class DictationRef: @unchecked Sendable {
    weak var value: IOSDictation?
    init(_ value: IOSDictation) { self.value = value }
}
