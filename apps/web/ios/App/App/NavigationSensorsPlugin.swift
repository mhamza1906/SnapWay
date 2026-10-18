import Capacitor
import CoreLocation
import CoreMotion
import UIKit

/// Experimental opt-in sensors. All state is in memory and stops when the app leaves the foreground.
@objc(NavigationSensorsPlugin)
public class NavigationSensorsPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "NavigationSensorsPlugin"
    public let jsName = "NavigationSensors"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startLocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMotion", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]
    private let locationManager = CLLocationManager()
    private let pedometer = CMPedometer()
    private let motion = CMMotionManager()
    private var generation = 0
    private var locationCall: CAPPluginCall?
    private var motionCall: CAPPluginCall?
    private var locationActive = false
    private var motionActive = false
    private var headingZero: Double?
    private var lastHeading: TimeInterval = 0
    private var observers: [NSObjectProtocol] = []
    private var motionPermissionReady: Int?
    private var foreground: Bool { UIApplication.shared.applicationState == .active }

    override public func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.locationManager.delegate = self
            self.locationManager.desiredAccuracy = kCLLocationAccuracyBest
            self.locationManager.distanceFilter = 1
            self.observers.append(NotificationCenter.default.addObserver(
                forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
            ) { [weak self] _ in self?.stopSensors() })
            self.observers.append(NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { [weak self] _ in
                guard let self else { return }
                self.authorizeLocation()
                if self.motionPermissionReady == self.generation, let call = self.motionCall {
                    self.motionPermissionReady = nil
                    self.motionCall = nil
                    self.beginMotion(generation: self.generation)
                    call.resolve()
                }
            })
        }
    }
    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        pedometer.stopUpdates()
        motion.stopDeviceMotionUpdates()
        locationManager.stopUpdatingLocation()
    }
    @objc public func startLocation(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.foreground else { call.reject("Open this screen before starting GPS."); return }
            if self.locationActive { call.resolve(); return }
            self.locationCall?.reject("GPS request superseded.")
            self.locationCall = call
            self.authorizeLocation()
        }
    }
    private func authorizeLocation() {
        guard foreground, let call = locationCall else { return }
        switch locationManager.authorizationStatus {
        case .notDetermined: locationManager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse:
            locationActive = true
            locationManager.startUpdatingLocation()
            locationCall = nil
            call.resolve()
        default:
            locationCall = nil
            call.reject("Location permission denied. Enable location in Settings.")
        }
    }
    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { authorizeLocation() }
    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard foreground, locationActive, let location = locations.last, location.horizontalAccuracy >= 0 else { return }
        notifyListeners("location", data: ["lat": location.coordinate.latitude, "lng": location.coordinate.longitude,
            "accuracy": location.horizontalAccuracy, "timestamp": location.timestamp.timeIntervalSince1970 * 1000])
    }
    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if foreground, locationActive { state("GPS: \(error.localizedDescription)") }
    }
    @objc public func startMotion(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.foreground else { call.reject("Open this screen before starting motion."); return }
            guard CMPedometer.isStepCountingAvailable() else { call.reject("This device has no hardware step counter."); return }
            if self.motionActive { call.resolve(); return }
            self.motionCall?.reject("Motion request superseded.")
            self.motionCall = call
            let current = self.generation
            // This prompts for Motion & Fitness permission, then starts a fresh per-session counter.
            let now = Date()
            self.pedometer.queryPedometerData(from: now.addingTimeInterval(-1), to: now) { [weak self] _, error in
                DispatchQueue.main.async {
                    guard let self, current == self.generation, self.motionCall === call else { return }
                    if let error {
                        self.motionCall = nil
                        call.reject("Motion permission or sensor unavailable: \(error.localizedDescription)")
                        return
                    }
                    if !self.foreground { self.motionPermissionReady = current; return }
                    self.motionCall = nil
                    self.beginMotion(generation: current)
                    call.resolve()
                }
            }
        }
    }
    private func beginMotion(generation current: Int) {
        motionActive = true
        headingZero = nil
        lastHeading = 0
        pedometer.startUpdates(from: Date()) { [weak self] data, error in
            DispatchQueue.main.async {
                guard let self, self.generation == current, self.foreground, self.motionActive else { return }
                if let error { self.state("Pedometer: \(error.localizedDescription)"); return }
                if let data { self.notifyListeners("steps", data: ["total": data.numberOfSteps.intValue,
                    "source": "native", "timestamp": data.endDate.timeIntervalSince1970 * 1000]) }
            }
        }
        guard motion.isDeviceMotionAvailable else { state("Rotation sensor unavailable. Movement estimation requires a working rotation sensor."); return }
        motion.deviceMotionUpdateInterval = 0.15
        motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: .main) { [weak self] data, error in
            guard let self, self.generation == current, self.foreground, self.motionActive else { return }
            if let error { self.state("Rotation: \(error.localizedDescription)"); return }
            guard let data, data.timestamp - self.lastHeading >= 0.14 else { return }
            self.lastHeading = data.timestamp
            let yaw = -data.attitude.yaw * 180 / .pi
            if self.headingZero == nil { self.headingZero = yaw }
            let degrees = (yaw - (self.headingZero ?? 0) + 720).truncatingRemainder(dividingBy: 360)
            self.notifyListeners("heading", data: ["degrees": degrees, "reference": "relative",
                "timestamp": Date().timeIntervalSince1970 * 1000])
        }
        state("Hardware steps enabled. Rotation is relative; set the starting direction on the floor map.")
    }
    private func state(_ message: String) { if foreground { notifyListeners("state", data: ["message": message]) } }
    @objc public func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in self?.stopSensors(); call.resolve() }
    }
    private func stopSensors() {
        generation += 1
        locationActive = false
        motionActive = false
        locationManager.stopUpdatingLocation()
        pedometer.stopUpdates()
        motion.stopDeviceMotionUpdates()
        locationCall?.reject("GPS start cancelled.")
        motionCall?.reject("Motion start cancelled.")
        locationCall = nil
        motionCall = nil
        motionPermissionReady = nil
    }
}
