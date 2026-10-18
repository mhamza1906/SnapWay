import Capacitor
import UIKit

/// Registers app-local plugins that are not distributed as npm packages.
class SnapWayViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(FrameCapturePlugin())
    }
}
