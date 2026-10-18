import ARKit
import AVFoundation
import Capacitor
import CoreImage
import ImageIO
import QuartzCore
import UIKit

/// Opt-in visual/inertial odometry. World coordinates are session-local metres, never a map location.
/// The JavaScript caller registers this world to its floor map using independently verified anchors.
@objc(IndoorPosePlugin)
public class IndoorPosePlugin: CAPPlugin, CAPBridgedPlugin, ARSessionDelegate {
    public let identifier = "IndoorPosePlugin"
    public let jsName = "IndoorPose"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "captureFrame", returnType: CAPPluginReturnPromise),
    ]

    // Lifecycle and AR callbacks are confined to main. Only JPEG encoding uses the serial queue.
    private var session = ARSession()
    private let imageQueue = DispatchQueue(label: "org.snapway.indoorpose.jpeg", qos: .userInitiated)
    private let imageContext = CIContext(options: [.cacheIntermediates: false])
    private var observers: [NSObjectProtocol] = []
    private var active = false
    private var generation = 0
    private var epoch = UUID().uuidString
    private var lastPoseTime: TimeInterval = 0
    private var pendingStart: CAPPluginCall?
    private var permissionGrantedPending = false
    private var encoding = false
    private var lastTracking = "unavailable"
    private var lastReason = "stopped"
    private var foreground: Bool { UIApplication.shared.applicationState == .active }

    override public func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let center = NotificationCenter.default
            self.observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification,
                object: nil, queue: .main) { [weak self] _ in
                    // A permission alert makes the app inactive. A pending request may resume only
                    // after its own granted callback; a running AR session always stops immediately.
                    guard let self, self.active else { return }
                    self.stopSession(reason: "inactive")
                })
            self.observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification,
                object: nil, queue: .main) { [weak self] _ in self?.stopSession(reason: "background") })
            self.observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification,
                object: nil, queue: .main) { [weak self] _ in
                    guard let self, self.permissionGrantedPending, let call = self.pendingStart else { return }
                    self.begin(call)
                })
        }
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        session.pause()
    }

    @objc public func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { call.reject("AR session unavailable."); return }
            guard self.foreground else { call.reject("Open this screen before starting AR tracking."); return }
            guard ARWorldTrackingConfiguration.isSupported else {
                call.reject("ARKit world tracking requires a supported physical iPhone or iPad.", "UNSUPPORTED")
                return
            }
            if self.active { call.resolve(["epoch": self.epoch]); return }
            self.generation += 1
            let requestedGeneration = self.generation
            self.pendingStart?.reject("AR start superseded.")
            self.pendingStart = call
            self.permissionGrantedPending = false
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized:
                self.begin(call)
            case .notDetermined:
                AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                    DispatchQueue.main.async {
                        guard let self, self.generation == requestedGeneration, self.pendingStart === call else { return }
                        guard granted else {
                            self.pendingStart = nil
                            call.reject("Camera permission denied. Enable Camera in Settings.", "PERMISSION")
                            return
                        }
                        self.permissionGrantedPending = true
                        if self.foreground { self.begin(call) }
                    }
                }
            default:
                self.pendingStart = nil
                call.reject("Camera permission denied. Enable Camera in Settings.", "PERMISSION")
            }
        }
    }

    private func begin(_ call: CAPPluginCall) {
        guard foreground, pendingStart === call else { return }
        permissionGrantedPending = false
        pendingStart = nil
        // A new object makes late callbacks from a stopped run distinguishable.
        session.delegate = nil
        session.pause()
        session = ARSession()
        session.delegate = self
        session.delegateQueue = .main
        epoch = UUID().uuidString
        lastPoseTime = 0
        active = true
        lastTracking = "unavailable"
        lastReason = "initializing"
        let configuration = ARWorldTrackingConfiguration()
        configuration.worldAlignment = .gravity
        configuration.isAutoFocusEnabled = true
        configuration.environmentTexturing = .none
        // No plane reconstruction, persistent world map, scene recording, or frame retention.
        session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        status(tracking: "limited", reason: "initializing")
        call.resolve(["epoch": epoch])
    }

    @objc public func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in self?.stopSession(reason: "stopped"); call.resolve() }
    }

    private func stopSession(reason: String) {
        generation += 1
        active = false
        pendingStart?.reject("AR start cancelled.")
        pendingStart = nil
        permissionGrantedPending = false
        session.delegate = nil
        session.pause()
        epoch = UUID().uuidString
        lastPoseTime = 0
        status(tracking: "unavailable", reason: reason)
    }

    private func tracking(_ state: ARCamera.TrackingState) -> (String, String) {
        switch state {
        case .normal: return ("normal", "")
        case .notAvailable: return ("unavailable", "camera_tracking_unavailable")
        case .limited(let reason):
            switch reason {
            case .initializing: return ("limited", "initializing")
            case .excessiveMotion: return ("limited", "excessive_motion")
            case .insufficientFeatures: return ("limited", "insufficient_features")
            case .relocalizing: return ("limited", "relocalizing")
            @unknown default: return ("limited", "unknown")
            }
        }
    }

    private func status(tracking: String, reason: String) {
        lastTracking = tracking
        lastReason = reason
        notifyListeners("status", data: ["tracking": tracking, "reason": reason, "message": reason, "epoch": epoch])
    }

    private func frameTimestamp(_ frame: ARFrame) -> Double {
        // ARFrame and CACurrentMediaTime share a monotonic timebase. Preserve the frame's time,
        // rather than stamping a delayed JPEG/network response with its completion time.
        (Date().timeIntervalSince1970 + frame.timestamp - CACurrentMediaTime()) * 1000
    }

    private func pose(_ frame: ARFrame) -> [String: Any] {
        let translation = frame.camera.transform.columns.3
        let backward = frame.camera.transform.columns.2
        return ["x": Double(translation.x), "y": Double(translation.y), "z": Double(translation.z),
                "yawRadians": atan2(Double(-backward.x), Double(-backward.z))]
    }

    public func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard session === self.session, active, foreground else { return }
        let (state, reason) = tracking(frame.camera.trackingState)
        if state != lastTracking || reason != lastReason {
            // Relocalization can change the world origin. All map registrations must be discarded.
            if reason == "relocalizing" && lastReason != reason { epoch = UUID().uuidString }
            status(tracking: state, reason: reason)
        }
        guard frame.timestamp - lastPoseTime >= 0.1 else { return }
        lastPoseTime = frame.timestamp
        var event = pose(frame)
        event["timestamp"] = frameTimestamp(frame)
        event["monotonicSeconds"] = frame.timestamp
        event["epoch"] = epoch
        event["tracking"] = state
        event["reason"] = reason
        notifyListeners("pose", data: event)
    }

    public func sessionWasInterrupted(_ session: ARSession) {
        guard session === self.session, active else { return }
        stopSession(reason: "interrupted")
    }
    public func sessionInterruptionEnded(_ session: ARSession) {
        guard session === self.session else { return }
        // Explicit restart creates a fresh world; never silently continue an obsolete map alignment.
        if !active { status(tracking: "unavailable", reason: "restart_required") }
    }
    public func session(_ session: ARSession, didFailWithError error: Error) {
        guard session === self.session, active else { return }
        stopSession(reason: "session_failed: \(error.localizedDescription)")
    }
    public func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool { false }

    @objc public func captureFrame(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.active, self.foreground else { call.reject("AR session is not active."); return }
            guard !self.encoding else { call.reject("A frame is already being encoded.", "BUSY"); return }
            guard let frame = self.session.currentFrame,
                  CACurrentMediaTime() - frame.timestamp >= 0,
                  CACurrentMediaTime() - frame.timestamp < 0.5 else {
                call.reject("A fresh camera frame is required.", "TRACKING")
                return
            }
            self.encoding = true
            let requestedGeneration = self.generation
            let frameEpoch = self.epoch
            let frameTime = self.frameTimestamp(frame)
            let framePose = self.pose(frame)
            let orientation = self.bridge?.viewController?.view.window?.windowScene?.interfaceOrientation ?? .portrait
            let imageOrientation: CGImagePropertyOrientation
            switch orientation {
            case .landscapeLeft: imageOrientation = .up
            case .landscapeRight: imageOrientation = .down
            case .portraitUpsideDown: imageOrientation = .left
            default: imageOrientation = .right
            }
            self.imageQueue.async { [weak self] in
                guard let self else { call.reject("AR session unavailable."); return }
                let encoded: (data: Data, width: Int, height: Int)? = autoreleasepool {
                    let upright = CIImage(cvPixelBuffer: frame.capturedImage).oriented(imageOrientation)
                    let longest = max(upright.extent.width, upright.extent.height)
                    let scale = min(1, 960 / longest)
                    let reduced = upright.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
                    guard let rendered = self.imageContext.createCGImage(reduced, from: reduced.extent.integral) else { return nil }
                    guard let data = UIImage(cgImage: rendered).jpegData(compressionQuality: 0.8) else { return nil }
                    return (data, rendered.width, rendered.height)
                }
                DispatchQueue.main.async {
                    self.encoding = false
                    guard self.active, self.foreground, self.generation == requestedGeneration, self.epoch == frameEpoch else {
                        call.reject("Frame cancelled because AR tracking restarted or stopped.", "CANCELLED")
                        return
                    }
                    guard let encoded else { call.reject("Unable to encode AR frame."); return }
                    call.resolve(["jpegBase64": encoded.data.base64EncodedString(), "width": encoded.width, "height": encoded.height, "timestamp": frameTime,
                        "monotonicSeconds": frame.timestamp, "epoch": frameEpoch, "pose": framePose])
                }
            }
        }
    }
}
