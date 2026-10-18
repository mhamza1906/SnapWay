package org.snapway.app;

import android.Manifest;
import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** Experimental foreground-only GPS and hardware pedometer. No persistence or background service. */
@CapacitorPlugin(name = "NavigationSensors", permissions = {
    @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
    @Permission(alias = "activity", strings = { Manifest.permission.ACTIVITY_RECOGNITION })
})
public class NavigationSensorsPlugin extends Plugin implements SensorEventListener, LocationListener {
    private SensorManager sensors;
    private LocationManager locations;
    private Sensor stepSensor;
    private SensorEventListener activeSensorListener;
    private LocationListener activeLocationListener;
    private boolean locationActive;
    private boolean motionActive;
    private boolean foreground = true;
    private int generation;
    private int total;
    private float counterBaseline = -1;
    private long lastHeadingNs;

    @Override public void load() {
        sensors = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        locations = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
    }

    @PluginMethod public void startLocation(PluginCall call) {
        new android.os.Handler(Looper.getMainLooper()).post(() -> startLocationOnMain(call));
    }

    private void startLocationOnMain(PluginCall call) {
        if (!foreground) { call.reject("Open this screen before starting GPS."); return; }
        call.getData().put("_generation", generation);
        if (!hasLocationPermission()) {
            requestPermissionForAlias("location", call, "locationPermission");
        } else beginLocation(call);
    }

    @PermissionCallback private void locationPermission(PluginCall call) {
        if (!current(call)) { call.reject("GPS start was cancelled."); return; }
        // Approximate location is supported; report its actual accuracy to the caller.
        if (!hasLocationPermission()) {
            call.reject("Location permission denied. Enable location in app settings."); return;
        }
        beginLocation(call);
    }

    private boolean hasLocationPermission() {
        return getContext().checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
            == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    private boolean current(PluginCall call) {
        return foreground && call.getInt("_generation", -1) == generation;
    }

    @SuppressWarnings("MissingPermission") private void beginLocation(PluginCall call) {
        if (!current(call)) { call.reject("GPS start was cancelled."); return; }
        if (locationActive) { call.resolve(); return; }
        if (locations == null) { call.reject("Location hardware is unavailable."); return; }
        final int currentGeneration = generation;
        activeLocationListener = new LocationListener() {
            @Override public void onLocationChanged(Location location) {
                if (currentGeneration == generation) NavigationSensorsPlugin.this.onLocationChanged(location);
            }
            @Override public void onProviderDisabled(String provider) {
                if (currentGeneration == generation) NavigationSensorsPlugin.this.onProviderDisabled(provider);
            }
            @Override public void onProviderEnabled(String provider) { }
            @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
        };
        boolean registered = false;
        for (String provider : new String[] {LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
            try {
                if (locations.isProviderEnabled(provider)) {
                    locations.requestLocationUpdates(provider, 1000, 0, activeLocationListener, Looper.getMainLooper());
                    registered = true;
                }
            } catch (SecurityException | IllegalArgumentException ignored) { }
        }
        locationActive = registered;
        if (registered) call.resolve();
        else call.reject("Enable device location and grant location permission before starting GPS.");
    }

    @PluginMethod public void startMotion(PluginCall call) {
        new android.os.Handler(Looper.getMainLooper()).post(() -> startMotionOnMain(call));
    }

    private void startMotionOnMain(PluginCall call) {
        if (!foreground) { call.reject("Open this screen before starting motion."); return; }
        call.getData().put("_generation", generation);
        if (Build.VERSION.SDK_INT >= 29 && getPermissionState("activity") != PermissionState.GRANTED) {
            requestPermissionForAlias("activity", call, "motionPermission");
        } else beginMotion(call);
    }

    @PermissionCallback private void motionPermission(PluginCall call) {
        if (!current(call)) { call.reject("Motion start was cancelled."); return; }
        if (getPermissionState("activity") != PermissionState.GRANTED) {
            call.reject("Physical activity permission denied. Enable it in app settings."); return;
        }
        beginMotion(call);
    }

    private void beginMotion(PluginCall call) {
        if (!current(call)) { call.reject("Motion start was cancelled."); return; }
        if (motionActive) { call.resolve(); return; }
        if (sensors == null) { call.reject("Motion sensors are unavailable."); return; }
        stepSensor = sensors.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR);
        if (stepSensor == null) stepSensor = sensors.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
        if (stepSensor == null) { call.reject("This device has no hardware step detector or counter."); return; }
        total = 0;
        counterBaseline = -1;
        lastHeadingNs = 0;
        final int currentGeneration = generation;
        activeSensorListener = new SensorEventListener() {
            @Override public void onSensorChanged(SensorEvent event) {
                if (currentGeneration == generation) NavigationSensorsPlugin.this.onSensorChanged(event);
            }
            @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {
                if (currentGeneration == generation) NavigationSensorsPlugin.this.onAccuracyChanged(sensor, accuracy);
            }
        };
        motionActive = sensors.registerListener(activeSensorListener, stepSensor, SensorManager.SENSOR_DELAY_NORMAL);
        if (!motionActive) { call.reject("The step sensor could not be started."); return; }
        Sensor rotation = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        if (rotation == null || !sensors.registerListener(activeSensorListener, rotation, SensorManager.SENSOR_DELAY_UI)) {
            state("Heading sensor unavailable. Movement estimation requires a working rotation sensor.");
        } else state("Hardware steps enabled. Compass heading may need calibration near metal.");
        call.resolve();
    }

    @Override public void onSensorChanged(SensorEvent event) {
        if (!foreground || !motionActive) return;
        int type = event.sensor.getType();
        if (type == Sensor.TYPE_STEP_DETECTOR) {
            total += Math.max(1, Math.round(event.values[0]));
            emitSteps();
        } else if (type == Sensor.TYPE_STEP_COUNTER) {
            if (counterBaseline < 0) counterBaseline = event.values[0];
            int next = Math.max(0, Math.round(event.values[0] - counterBaseline));
            if (next > total) { total = next; emitSteps(); }
        } else if (type == Sensor.TYPE_ROTATION_VECTOR && event.timestamp - lastHeadingNs > 150_000_000) {
            lastHeadingNs = event.timestamp;
            float[] matrix = new float[9];
            float[] orientation = new float[3];
            SensorManager.getRotationMatrixFromVector(matrix, event.values);
            SensorManager.getOrientation(matrix, orientation);
            double degrees = (Math.toDegrees(orientation[0]) + 360) % 360;
            JSObject value = new JSObject();
            value.put("degrees", degrees);
            value.put("reference", "absolute"); // magnetic compass; not an indoor north guarantee
            value.put("timestamp", System.currentTimeMillis());
            notifyListeners("heading", value);
        }
    }
    private void emitSteps() {
        JSObject value = new JSObject();
        value.put("total", total);
        value.put("source", "native");
        value.put("timestamp", System.currentTimeMillis());
        notifyListeners("steps", value);
    }
    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {
        if (motionActive && sensor.getType() == Sensor.TYPE_ROTATION_VECTOR && accuracy == SensorManager.SENSOR_STATUS_UNRELIABLE)
            state("Heading is unreliable. Pause, then re-anchor and recalibrate away from metal.");
    }
    @Override public void onLocationChanged(Location location) {
        if (!foreground || !locationActive || !location.hasAccuracy()) return;
        JSObject value = new JSObject();
        value.put("lat", location.getLatitude());
        value.put("lng", location.getLongitude());
        value.put("accuracy", location.getAccuracy());
        value.put("timestamp", location.getTime());
        notifyListeners("location", value);
    }
    @Override public void onProviderDisabled(String provider) { if (locationActive) state("Location provider disabled: " + provider); }
    @Override public void onProviderEnabled(String provider) { }
    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
    private void state(String message) { if (foreground) notifyListeners("state", new JSObject().put("message", message)); }
    @PluginMethod public void stop(PluginCall call) { new android.os.Handler(Looper.getMainLooper()).post(() -> { stopSensors(); call.resolve(); }); }
    private void stopSensors() {
        generation++;
        locationActive = false;
        motionActive = false;
        if (sensors != null && activeSensorListener != null) sensors.unregisterListener(activeSensorListener);
        if (locations != null && activeLocationListener != null) locations.removeUpdates(activeLocationListener);
        activeSensorListener = null;
        activeLocationListener = null;
    }
    @Override protected void handleOnPause() { foreground = false; stopSensors(); }
    @Override protected void handleOnResume() { foreground = true; }
    @Override protected void handleOnDestroy() { foreground = false; stopSensors(); }
}
