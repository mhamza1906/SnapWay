import AVFoundation
import Capacitor
import CoreImage
import Foundation
import ImageIO
import PhotosUI
import Security
import UIKit
import UniformTypeIdentifiers

/// Captures upright JPEG frames for photo localization, only with camera permission and only
/// while the capture screen is open in the foreground. Frames stay in the app sandbox until the
/// user uploads or deletes them. Uploads go to the development server configured in the debug
/// settings screen; the token lives in the Keychain and never reaches JavaScript.
@objc(FrameCapturePlugin)
public class FrameCapturePlugin: CAPPlugin, CAPBridgedPlugin, AVCaptureVideoDataOutputSampleBufferDelegate {
    public let identifier = "FrameCapturePlugin"
    public let jsName = "FrameCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listFrames", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFrame", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discardFrame", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteFrames", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importVideo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "uploadFrame", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "testConnection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchThumbnail", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDevConfig", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setDevConfig", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearDevConfig", returnType: CAPPluginReturnPromise),
    ]

    private static let maxSide: CGFloat = 1024
    private static let jpegQuality: CGFloat = 0.9
    private static let maxStoredFrames = 30
    private static let maxVideoFrames = 120

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "org.snapway.framecapture.session")
    private let videoQueue = DispatchQueue(label: "org.snapway.framecapture.video", qos: .userInitiated)
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private var configured = false
    private var capturing = false
    private var interval = CMTime(value: 1, timescale: 1)
    private var startPTS: CMTime?
    private var lastPTS: CMTime?
    private var encoding = false
    private var nextFrameId = 0
    private var rotationCoordinator: AnyObject?
    private var observers: [NSObjectProtocol] = []
    private var pickerCall: CAPPluginCall?

    // MARK: - Lifecycle

    override public func load() {
        nextFrameId = (listStoredMetadata().compactMap { $0["client_frame_id"] as? Int }.max() ?? -1) + 1
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.stopCapture(reason: "background")
        })
        observers.append(center.addObserver(forName: .AVCaptureSessionWasInterrupted, object: session, queue: .main) { [weak self] _ in
            self?.stopCapture(reason: "interrupted")
        })
        observers.append(center.addObserver(forName: .AVCaptureSessionRuntimeError, object: session, queue: .main) { [weak self] _ in
            self?.stopCapture(reason: "camera_error")
        })
        observers.append(center.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            let state = ProcessInfo.processInfo.thermalState
            if state == .serious || state == .critical {
                self?.stopCapture(reason: "thermal")
            }
        })
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    // MARK: - Permission

    private func cameraStatus() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "denied"
        }
    }

    private var isDebugBuild: Bool {
        #if DEBUG
            return true
        #else
            return false
        #endif
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve([
            "camera": cameraStatus(),
            "cameraAvailable": AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil,
            "debugBuild": isDebugBuild,
            "capturing": capturing,
            "storedFrames": listStoredMetadata().count,
        ])
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        if AVCaptureDevice.authorizationStatus(for: .video) != .notDetermined {
            call.resolve(["camera": cameraStatus()])
            return
        }
        AVCaptureDevice.requestAccess(for: .video) { [weak self] _ in
            call.resolve(["camera": self?.cameraStatus() ?? "denied"])
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("Settings unavailable")
                return
            }
            UIApplication.shared.open(url) { opened in call.resolve(["opened": opened]) }
        }
    }

    // MARK: - Live capture

    @objc func start(_ call: CAPPluginCall) {
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
            call.reject("Camera permission is \(cameraStatus())", "PERMISSION")
            return
        }
        guard UIApplication.shared.applicationState == .active else {
            call.reject("Capture only runs in the foreground", "BACKGROUND")
            return
        }
        let fps = min(5.0, max(0.5, call.getDouble("fps") ?? 1.0))
        interval = CMTime(seconds: 1.0 / fps, preferredTimescale: 600)
        sessionQueue.async { [weak self] in
            guard let self else { return }
            do {
                try self.configureIfNeeded()
            } catch {
                call.reject("Camera unavailable: \(error.localizedDescription)", "UNAVAILABLE")
                return
            }
            self.startPTS = nil
            self.lastPTS = nil
            if !self.session.isRunning {
                self.session.startRunning()
            }
            self.capturing = self.session.isRunning
            self.notifyListeners("state", data: ["capturing": self.capturing, "reason": "started"])
            call.resolve(["capturing": self.capturing, "fps": fps])
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        stopCapture(reason: "user") { call.resolve(["capturing": false]) }
    }

    private func stopCapture(reason: String, completion: (() -> Void)? = nil) {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            let wasCapturing = self.capturing
            self.capturing = false
            if self.session.isRunning {
                self.session.stopRunning()
            }
            self.capturing = false
            if wasCapturing {
                self.notifyListeners("state", data: ["capturing": false, "reason": reason])
            }
            // Drain a frame already being encoded before a caller clears the temporary cache.
            self.videoQueue.async { completion?() }
        }
    }

    private func configureIfNeeded() throws {
        if configured { return }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw NSError(domain: "FrameCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "No back wide camera"])
        }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = session.canSetSessionPreset(.hd1280x720) ? .hd1280x720 : .high
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            throw NSError(domain: "FrameCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot add camera input"])
        }
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: videoQueue)
        guard session.canAddOutput(output) else {
            throw NSError(domain: "FrameCapture", code: 3, userInfo: [NSLocalizedDescriptionKey: "Cannot add video output"])
        }
        session.addOutput(output)
        if #available(iOS 17.0, *) {
            rotationCoordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: nil)
        } else {
            DispatchQueue.main.async { UIDevice.current.beginGeneratingDeviceOrientationNotifications() }
        }
        configured = true
    }

    /// Clockwise degrees that make the sensor image upright for the current device orientation.
    private func rotationAngle() -> CGFloat {
        if #available(iOS 17.0, *), let coordinator = rotationCoordinator as? AVCaptureDevice.RotationCoordinator {
            return coordinator.videoRotationAngleForHorizonLevelCapture
        }
        switch UIDevice.current.orientation {
        case .portraitUpsideDown: return 270
        case .landscapeLeft: return 0
        case .landscapeRight: return 180
        default: return 90
        }
    }

    private func orientationName(for angle: CGFloat) -> String {
        switch Int(angle.rounded()) % 360 {
        case 90: return "portrait"
        case 270: return "portraitUpsideDown"
        case 0: return "landscapeLeft"
        case 180: return "landscapeRight"
        default: return "unknown"
        }
    }

    private func exifOrientation(for angle: CGFloat) -> CGImagePropertyOrientation {
        switch Int(angle.rounded()) % 360 {
        case 90: return .right
        case 180: return .down
        case 270: return .left
        default: return .up
        }
    }

    public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard capturing else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if startPTS == nil { startPTS = pts }
        // Select by presentation time, not by counting callbacks.
        if let last = lastPTS, CMTimeCompare(CMTimeSubtract(pts, last), interval) < 0 { return }
        guard !encoding, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer), let start = startPTS else { return }
        lastPTS = pts
        encoding = true
        let angle = rotationAngle()
        let image = CIImage(cvPixelBuffer: pixelBuffer).oriented(exifOrientation(for: angle))
        let meta: [String: Any] = [
            "timestamp_s": CMTimeGetSeconds(CMTimeSubtract(pts, start)),
            "captured_at": ISO8601DateFormatter().string(from: Date()),
            "orientation": orientationName(for: angle),
            "source": "camera",
        ]
        defer { encoding = false }
        if let event = storeFrame(image: image, meta: meta) {
            notifyListeners("frame", data: event)
        }
    }

    // MARK: - Frames on disk

    private func framesDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var dir = base.appendingPathComponent("captured-frames", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? dir.setResourceValues(values)
        }
        return dir
    }

    private func upright(_ image: CIImage) -> CIImage {
        let extent = image.extent
        let scale = min(1, Self.maxSide / max(extent.width, extent.height))
        let moved = image.transformed(by: CGAffineTransform(translationX: -extent.origin.x, y: -extent.origin.y))
        return scale < 1 ? moved.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) : moved
    }

    /// Encodes, measures and stores one frame; returns the event payload (with a small preview).
    private func storeFrame(image: CIImage, meta: [String: Any]) -> [String: Any]? {
        let scaled = upright(image)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let jpeg = ciContext.jpegRepresentation(
                  of: scaled, colorSpace: space,
                  options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: Self.jpegQuality]
              )
        else { return nil }
        let frameId = nextFrameId
        nextFrameId += 1
        let quality = measure(scaled)
        var record = meta
        record["client_frame_id"] = frameId
        record["width"] = Int(scaled.extent.width.rounded())
        record["height"] = Int(scaled.extent.height.rounded())
        record["bytes"] = jpeg.count
        record["quality"] = quality
        let dir = framesDirectory()
        do {
            try jpeg.write(to: dir.appendingPathComponent("\(frameId).jpg"), options: .completeFileProtection)
            let json = try JSONSerialization.data(withJSONObject: record)
            try json.write(to: dir.appendingPathComponent("\(frameId).json"), options: .completeFileProtection)
        } catch {
            return nil
        }
        pruneStoredFrames()
        var event = record
        let preview = scaled.transformed(by: CGAffineTransform(scaleX: 0.3, y: 0.3))
        if let space = CGColorSpace(name: CGColorSpace.sRGB),
           let small = ciContext.jpegRepresentation(of: preview, colorSpace: space, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.5]) {
            event["preview"] = "data:image/jpeg;base64," + small.base64EncodedString()
        }
        return event
    }

    /// Cheap on-device flags (heuristics on a 64 px grey image). The server measures again.
    private func measure(_ image: CIImage) -> [String: Any] {
        let side: CGFloat = 64
        let scale = side / max(image.extent.width, image.extent.height)
        let small = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let w = Int(small.extent.width.rounded()), h = Int(small.extent.height.rounded())
        guard w > 2, h > 2 else { return ["flags": []] }
        var pixels = [UInt8](repeating: 0, count: w * h * 4)
        ciContext.render(small, toBitmap: &pixels, rowBytes: w * 4, bounds: CGRect(x: 0, y: 0, width: w, height: h), format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        var luma = [Double](repeating: 0, count: w * h)
        for i in 0..<(w * h) {
            luma[i] = 0.299 * Double(pixels[i * 4]) + 0.587 * Double(pixels[i * 4 + 1]) + 0.114 * Double(pixels[i * 4 + 2])
        }
        let mean = luma.reduce(0, +) / Double(luma.count)
        var lap: [Double] = []
        for y in 1..<(h - 1) {
            for x in 1..<(w - 1) {
                let c = luma[y * w + x]
                lap.append(luma[y * w + x - 1] + luma[y * w + x + 1] + luma[(y - 1) * w + x] + luma[(y + 1) * w + x] - 4 * c)
            }
        }
        let lapMean = lap.reduce(0, +) / Double(max(1, lap.count))
        let blur = lap.reduce(0) { $0 + ($1 - lapMean) * ($1 - lapMean) } / Double(max(1, lap.count))
        var flags: [String] = []
        if blur < 30 { flags.append("blurry") }
        if mean < 40 { flags.append("underexposed") }
        if mean > 225 { flags.append("overexposed") }
        return ["mean_luma": (mean * 10).rounded() / 10, "blur_score": (blur * 10).rounded() / 10, "flags": flags, "method": "device-heuristic-64px"]
    }

    private func listStoredMetadata() -> [[String: Any]] {
        let dir = framesDirectory()
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }.compactMap { url in
            guard let data = try? Data(contentsOf: url) else { return nil }
            return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }.sorted { ($0["client_frame_id"] as? Int ?? 0) < ($1["client_frame_id"] as? Int ?? 0) }
    }

    private func pruneStoredFrames() {
        let stored = listStoredMetadata()
        guard stored.count > Self.maxStoredFrames else { return }
        let dir = framesDirectory()
        for meta in stored.prefix(stored.count - Self.maxStoredFrames) {
            guard let id = meta["client_frame_id"] as? Int else { continue }
            try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(id).jpg"))
            try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(id).json"))
        }
    }

    @objc func listFrames(_ call: CAPPluginCall) {
        call.resolve(["frames": listStoredMetadata()])
    }

    /// Bounded app-local JPEG for the visitor NavigationSession transport, including release builds.
    /// The caller still obtains a server-issued capability; no developer credential crosses the bridge.
    @objc func readFrame(_ call: CAPPluginCall) {
        guard let id = call.getInt("clientFrameId"), id >= 0 else {
            call.reject("A valid clientFrameId is required", "MISSING")
            return
        }
        videoQueue.async { [weak self] in
            guard let self,
                  let data = try? Data(contentsOf: self.framesDirectory().appendingPathComponent("\(id).jpg")) else {
                call.reject("Frame is no longer stored", "MISSING")
                return
            }
            call.resolve(["dataUrl": "data:image/jpeg;base64," + data.base64EncodedString()])
        }
    }

    @objc func discardFrame(_ call: CAPPluginCall) {
        guard let id = call.getInt("clientFrameId"), id >= 0 else {
            call.reject("A valid clientFrameId is required", "MISSING")
            return
        }
        videoQueue.async { [weak self] in
            guard let self else { call.reject("Capture unavailable"); return }
            let dir = self.framesDirectory()
            try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(id).jpg"))
            try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(id).json"))
            call.resolve(["deleted": true])
        }
    }

    @objc func deleteFrames(_ call: CAPPluginCall) {
        videoQueue.async { [weak self] in
            guard let self else { call.reject("Capture unavailable"); return }
            let dir = self.framesDirectory()
            let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            files.forEach { try? FileManager.default.removeItem(at: $0) }
            call.resolve(["deleted": files.filter { $0.pathExtension == "jpg" }.count])
        }
    }

    // MARK: - Recorded video (PHPicker: no photo-library permission)

    @objc func importVideo(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.bridge?.viewController else {
                call.reject("No view controller")
                return
            }
            var config = PHPickerConfiguration()
            config.filter = .videos
            config.selectionLimit = 1
            config.preferredAssetRepresentationMode = .current
            let picker = PHPickerViewController(configuration: config)
            picker.delegate = self
            self.pickerCall = call
            presenter.present(picker, animated: true)
        }
    }

    private func extractFrames(from url: URL, fps: Double, call: CAPPluginCall) {
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true  // upright, like the server's extraction
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let duration = CMTimeGetSeconds(asset.duration)
        guard duration.isFinite, duration > 0 else {
            call.reject("Could not read the video duration")
            return
        }
        let step = 1.0 / min(5.0, max(0.5, fps))
        var times: [Double] = []
        var t = 0.0
        while t < duration, times.count < Self.maxVideoFrames {
            times.append(t)
            t += step
        }
        var count = 0
        let capturedAt = ISO8601DateFormatter().string(from: Date())
        for requested in times {
            var actual = CMTime.zero
            guard let cg = try? generator.copyCGImage(at: CMTime(seconds: requested, preferredTimescale: 600), actualTime: &actual) else { continue }
            let meta: [String: Any] = [
                "timestamp_s": CMTimeGetSeconds(actual),  // actual time of the decoded frame
                "captured_at": capturedAt,
                "orientation": "unknown",
                "source": "video",
            ]
            if let event = storeFrame(image: CIImage(cgImage: cg), meta: meta) {
                notifyListeners("frame", data: event)
                count += 1
            }
        }
        try? FileManager.default.removeItem(at: url)
        call.resolve(["frames": count, "duration_s": duration, "truncated": t < duration])
    }

    // MARK: - Development server configuration (debug builds only)

    private let keychainService = "org.snapway.app.placematch"
    private let keychainAccount = "dev-token"
    private let defaultsBaseURL = "placematch.dev.baseURL"
    private let defaultsMode = "placematch.dev.mode"

    private func keychainToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func setKeychainToken(_ token: String?) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
        SecItemDelete(base as CFDictionary)
        guard let token, !token.isEmpty, let data = token.data(using: .utf8) else { return }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    @objc func getDevConfig(_ call: CAPPluginCall) {
        guard isDebugBuild else {
            call.resolve(["available": false])
            return
        }
        let defaults = UserDefaults.standard
        call.resolve([
            "available": true,
            "baseUrl": defaults.string(forKey: defaultsBaseURL) ?? "",
            "mode": defaults.string(forKey: defaultsMode) ?? "engine",
            "hasToken": keychainToken() != nil,
        ])
    }

    @objc func setDevConfig(_ call: CAPPluginCall) {
        guard isDebugBuild else {
            call.reject("Development settings are not available in release builds", "RELEASE")
            return
        }
        let base = (call.getString("baseUrl") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: base), let scheme = url.scheme, let host = url.host,
              scheme == "https" || (scheme == "http" && ["127.0.0.1", "localhost"].contains(host))
        else {
            call.reject("Use an https:// address (http is allowed only for localhost in the Simulator)", "URL")
            return
        }
        let mode = call.getString("mode") == "snapway" ? "snapway" : "engine"
        UserDefaults.standard.set(base.hasSuffix("/") ? String(base.dropLast()) : base, forKey: defaultsBaseURL)
        UserDefaults.standard.set(mode, forKey: defaultsMode)
        if let token = call.getString("token"), !token.isEmpty {
            setKeychainToken(token)
        }
        call.resolve(["saved": true, "hasToken": keychainToken() != nil])
    }

    @objc func clearDevConfig(_ call: CAPPluginCall) {
        UserDefaults.standard.removeObject(forKey: defaultsBaseURL)
        UserDefaults.standard.removeObject(forKey: defaultsMode)
        setKeychainToken(nil)
        call.resolve(["cleared": true])
    }

    // MARK: - Network (token added natively)

    private func endpoint(_ engineSuffix: String, _ snapwaySuffix: String) -> (URL, String)? {
        guard isDebugBuild,
              let base = UserDefaults.standard.string(forKey: defaultsBaseURL), !base.isEmpty,
              let token = keychainToken()
        else { return nil }
        let mode = UserDefaults.standard.string(forKey: defaultsMode) ?? "engine"
        let path = mode == "snapway" ? snapwaySuffix : engineSuffix
        guard let url = URL(string: base + path) else { return nil }
        return (url, token)
    }

    private func send(_ request: URLRequest, call: CAPPluginCall, binary: Bool = false) {
        let started = Date()
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                call.reject("Network error: \(error.localizedDescription)", "NETWORK")
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let roundTrip = Int(Date().timeIntervalSince(started) * 1000)
            let payload = data ?? Data()
            if binary, status == 200 {
                call.resolve(["status": status, "dataUrl": "data:image/jpeg;base64," + payload.base64EncodedString(), "roundTripMs": roundTrip])
            } else {
                call.resolve(["status": status, "body": String(data: payload, encoding: .utf8) ?? "", "roundTripMs": roundTrip])
            }
        }.resume()
    }

    @objc func testConnection(_ call: CAPPluginCall) {
        guard let target = endpoint("/v1/health", "/api/navigation/localize/health/") else {
            call.reject("Set the server address and token in debug settings first", "CONFIG")
            return
        }
        var request = URLRequest(url: target.0, timeoutInterval: 15)
        request.setValue("Bearer \(target.1)", forHTTPHeaderField: "Authorization")
        send(request, call: call)
    }

    @objc func fetchThumbnail(_ call: CAPPluginCall) {
        let set = call.getString("referenceSet") ?? ""
        let ref = call.getString("referenceId") ?? ""
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "?#"))
        guard let setPart = set.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
              let refPart = ref.addingPercentEncoding(withAllowedCharacters: allowed),
              let target = endpoint(
                  "/v1/references/\(setPart)/thumb/\(refPart)",
                  "/api/navigation/localize/references/\(setPart)/thumb/\(refPart)")
        else {
            call.reject("Thumbnail unavailable", "CONFIG")
            return
        }
        var request = URLRequest(url: target.0, timeoutInterval: 15)
        request.setValue("Bearer \(target.1)", forHTTPHeaderField: "Authorization")
        send(request, call: call, binary: true)
    }

    @objc func uploadFrame(_ call: CAPPluginCall) {
        guard let frameId = call.getInt("clientFrameId") else {
            call.reject("clientFrameId is required")
            return
        }
        let dir = framesDirectory()
        guard let jpeg = try? Data(contentsOf: dir.appendingPathComponent("\(frameId).jpg")),
              let metaData = try? Data(contentsOf: dir.appendingPathComponent("\(frameId).json")),
              let stored = (try? JSONSerialization.jsonObject(with: metaData)) as? [String: Any]
        else {
            call.reject("Frame \(frameId) is no longer stored", "MISSING")
            return
        }
        let backend = ["auto", "megaloc", "vertex"].contains(call.getString("backend") ?? "") ? call.getString("backend")! : "auto"
        let query = "?backend=\(backend)&verify=\(call.getBool("verify") ?? false)&second_opinion=\(call.getBool("secondOpinion") ?? false)"
        guard let target = endpoint("/v1/match" + query, "/api/navigation/localize/" + query) else {
            call.reject("Set the server address and token in debug settings first", "CONFIG")
            return
        }
        var meta: [String: Any] = ["client_frame_id": frameId]
        for key in ["timestamp_s", "captured_at", "orientation", "source"] {
            if let value = stored[key] { meta[key] = value }
        }
        if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
            meta["app_version"] = String(version.prefix(32))
        }
        guard let metaJSON = try? JSONSerialization.data(withJSONObject: meta) else {
            call.reject("Could not encode frame metadata")
            return
        }
        let boundary = "snapway-\(UUID().uuidString)"
        var body = Data()
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"meta\"\r\nContent-Type: application/json\r\n\r\n".data(using: .utf8)!)
        body.append(metaJSON)
        body.append("\r\n--\(boundary)\r\nContent-Disposition: form-data; name=\"image\"; filename=\"frame.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(jpeg)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        var request = URLRequest(url: target.0, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue("Bearer \(target.1)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        send(request, call: call)
    }
}

extension FrameCapturePlugin: PHPickerViewControllerDelegate {
    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let call = pickerCall else { return }
        pickerCall = nil
        guard let provider = results.first?.itemProvider,
              provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier)
        else {
            call.resolve(["frames": 0, "cancelled": true])
            return
        }
        let fps = call.getDouble("fps") ?? 1.0
        provider.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier) { [weak self] url, error in
            guard let self, let url else {
                call.reject("Could not load the video: \(error?.localizedDescription ?? "unknown error")")
                return
            }
            // The provided file is deleted when this handler returns: copy it first.
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "." + url.pathExtension)
            do {
                try FileManager.default.copyItem(at: url, to: copy)
            } catch {
                call.reject("Could not copy the video")
                return
            }
            self.videoQueue.async { self.extractFrames(from: copy, fps: fps, call: call) }
        }
    }
}
