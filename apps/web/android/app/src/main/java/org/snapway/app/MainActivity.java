package org.snapway.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FrameCapturePlugin.class);
        registerPlugin(NavigationSensorsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
