package org.snapway.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.ExifInterface;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Size;
import android.view.Surface;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

import java.security.KeyStore;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** App-local foreground camera bridge. No audio, background service or shared-storage access. */
@CapacitorPlugin(name = "FrameCapture", permissions = {
    @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
})
public class FrameCapturePlugin extends Plugin {
    private static final int MAX_FRAMES = 30;
    private static final int MAX_VIDEO_FRAMES = 120;
    private static final int MAX_SIDE = 1024;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private HandlerThread cameraThread;
    private Handler cameraHandler;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private ImageReader reader;
    private volatile boolean capturing;
    private volatile boolean foreground = true;
    private volatile int generation;
    private long intervalMs = 1000;
    private long startedNs;
    private int nextFrameId;
    private int sensorOrientation;
    private PowerManager.OnThermalStatusChangedListener thermalListener;

    @Override public void load() {
        cameraThread = new HandlerThread("snapway-frame-camera");
        cameraThread.start();
        cameraHandler = new Handler(cameraThread.getLooper());
        for (JSObject frame : storedFrames()) nextFrameId = Math.max(nextFrameId, frame.optInt("client_frame_id") + 1);
        if (Build.VERSION.SDK_INT >= 29) {
            thermalListener = status -> {
                if (status >= PowerManager.THERMAL_STATUS_SEVERE) stopCapture("thermal");
            };
            getContext().getSystemService(PowerManager.class).addThermalStatusListener(thermalListener);
        }
    }

    private boolean debugBuild() {
        return (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }
    private String permission() {
        PermissionState state = getPermissionState("camera");
        if (state == PermissionState.GRANTED) return "authorized";
        return state == PermissionState.PROMPT ? "notDetermined" : "denied";
    }
    private String backCamera() throws Exception {
        CameraManager manager = getContext().getSystemService(CameraManager.class);
        for (String id : manager.getCameraIdList()) {
            Integer facing = manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);
            if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) return id;
        }
        return null;
    }
    @PluginMethod public void getStatus(PluginCall call) {
        boolean available = false;
        try { available = backCamera() != null; } catch (Exception ignored) { }
        call.resolve(new JSObject().put("camera", permission()).put("cameraAvailable", available)
            .put("debugBuild", debugBuild()).put("capturing", capturing).put("storedFrames", storedFrames().size()));
    }
    @PluginMethod public void requestPermission(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) permissionResult(call);
        else requestPermissionForAlias("camera", call, "permissionResult");
    }
    @PermissionCallback private void permissionResult(PluginCall call) {
        call.resolve(new JSObject().put("camera", permission()));
    }
    @PluginMethod public void openSettings(PluginCall call) {
        getActivity().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:" + getContext().getPackageName())));
        call.resolve(new JSObject().put("opened", true));
    }

    @PluginMethod public void start(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("Allow camera access in Settings, then try again.", "PERMISSION"); return;
        }
        if (!foreground) { call.reject("Capture only runs in the foreground", "BACKGROUND"); return; }
        double fps = Math.min(5, Math.max(0.5, call.getDouble("fps", 1.0)));
        intervalMs = Math.round(1000 / fps);
        if (capturing) { call.resolve(new JSObject().put("capturing", true).put("fps", fps)); return; }
        int run = ++generation;
        cameraHandler.post(() -> openCamera(call, fps, run));
    }
    @SuppressWarnings("MissingPermission")
    private void openCamera(PluginCall call, double fps, int run) {
        try {
            if (run != generation || !foreground) { call.reject("Capture cancelled", "BACKGROUND"); return; }
            CameraManager manager = getContext().getSystemService(CameraManager.class);
            String id = backCamera();
            if (id == null) { call.reject("No back camera is available", "UNAVAILABLE"); return; }
            CameraCharacteristics characteristics = manager.getCameraCharacteristics(id);
            sensorOrientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION);
            StreamConfigurationMap map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map == null) throw new IllegalStateException("No camera output configuration");
            Size[] sizes = map.getOutputSizes(android.graphics.ImageFormat.JPEG);
            Size size = Arrays.stream(sizes).filter(s -> Math.max(s.getWidth(), s.getHeight()) <= 1920)
                .min(Comparator.comparingInt(s -> Math.abs(Math.max(s.getWidth(), s.getHeight()) - 1280)))
                .orElseGet(() -> Arrays.stream(sizes).min(Comparator.comparingLong(s -> (long) s.getWidth() * s.getHeight())).orElseThrow(() -> new IllegalStateException("No JPEG output size")));
            reader = ImageReader.newInstance(size.getWidth(), size.getHeight(), android.graphics.ImageFormat.JPEG, 2);
            reader.setOnImageAvailableListener(source -> receivedImage(source, run), cameraHandler);
            manager.openCamera(id, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice device) {
                    if (run != generation || !foreground) { device.close(); call.reject("Capture cancelled", "BACKGROUND"); return; }
                    camera = device;
                    try {
                        device.createCaptureSession(Collections.singletonList(reader.getSurface()), new CameraCaptureSession.StateCallback() {
                            @Override public void onConfigured(CameraCaptureSession configured) {
                                if (run != generation || !foreground) { configured.close(); call.reject("Capture cancelled", "BACKGROUND"); return; }
                                session = configured;
                                startedNs = 0;
                                capturing = true;
                                notifyListeners("state", new JSObject().put("capturing", true).put("reason", "started"));
                                call.resolve(new JSObject().put("capturing", true).put("fps", fps));
                                captureNext(run);
                            }
                            @Override public void onConfigureFailed(CameraCaptureSession failed) {
                                stopCapture("camera_error"); call.reject("Could not configure the camera", "UNAVAILABLE");
                            }
                        }, cameraHandler);
                    } catch (Exception error) { stopCapture("camera_error"); call.reject("Camera unavailable", "UNAVAILABLE"); }
                }
                @Override public void onDisconnected(CameraDevice device) {
                    device.close(); stopCapture("interrupted"); call.reject("The camera was interrupted", "UNAVAILABLE");
                }
                @Override public void onError(CameraDevice device, int error) {
                    device.close(); stopCapture("camera_error"); call.reject("Camera unavailable", "UNAVAILABLE");
                }
            }, cameraHandler);
        } catch (Exception error) { stopCapture("camera_error"); call.reject("Camera unavailable", "UNAVAILABLE"); }
    }
    private int jpegRotation() {
        int rotation = getActivity().getWindowManager().getDefaultDisplay().getRotation();
        int degrees = rotation == Surface.ROTATION_90 ? 90 : rotation == Surface.ROTATION_180 ? 180 : rotation == Surface.ROTATION_270 ? 270 : 0;
        return (sensorOrientation - degrees + 360) % 360;
    }
    private void captureNext(int run) {
        if (!capturing || run != generation || session == null || camera == null || reader == null) return;
        try {
            CaptureRequest.Builder request = camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
            request.addTarget(reader.getSurface());
            request.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            request.set(CaptureRequest.JPEG_ORIENTATION, jpegRotation());
            request.set(CaptureRequest.JPEG_QUALITY, (byte) 90);
            session.capture(request.build(), null, cameraHandler);
            cameraHandler.postDelayed(() -> captureNext(run), intervalMs);
        } catch (Exception error) { stopCapture("camera_error"); }
    }
    private void receivedImage(ImageReader source, int run) {
        try (Image image = source.acquireLatestImage()) {
            if (image == null || !capturing || generation != run) return;
            ByteBuffer buffer = image.getPlanes()[0].getBuffer();
            byte[] jpeg = new byte[buffer.remaining()]; buffer.get(jpeg);
            Bitmap bitmap = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
            if (bitmap == null) return;
            ExifInterface exif = new ExifInterface(new ByteArrayInputStream(jpeg));
            int orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            int angle = orientation == ExifInterface.ORIENTATION_ROTATE_90 ? 90 : orientation == ExifInterface.ORIENTATION_ROTATE_180 ? 180 : orientation == ExifInterface.ORIENTATION_ROTATE_270 ? 270 : 0;
            if (angle != 0) {
                Matrix matrix = new Matrix(); matrix.postRotate(angle);
                Bitmap upright = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
                if (upright != bitmap) bitmap.recycle(); bitmap = upright;
            }
            long timestamp = image.getTimestamp();
            if (startedNs == 0) startedNs = timestamp;
            JSObject meta = new JSObject().put("timestamp_s", (timestamp - startedNs) / 1_000_000_000.0)
                .put("captured_at", timestampNow()).put("source", "camera")
                .put("orientation", bitmap.getHeight() >= bitmap.getWidth() ? "portrait" : "landscapeLeft");
            JSObject frame = storeFrame(bitmap, meta);
            bitmap.recycle();
            if (frame != null && capturing && run == generation) notifyListeners("frame", frame);
        } catch (Exception error) { if (capturing) stopCapture("camera_error"); }
    }
    @PluginMethod public void stop(PluginCall call) {
        stopCapture("user"); call.resolve(new JSObject().put("capturing", false));
    }
    private void stopCapture(String reason) {
        generation++;
        boolean wasCapturing = capturing;
        capturing = false;
        cameraHandler.post(() -> {
            if (session != null) { session.close(); session = null; }
            if (camera != null) { camera.close(); camera = null; }
            if (reader != null) { reader.close(); reader = null; }
        });
        if (wasCapturing) notifyListeners("state", new JSObject().put("capturing", false).put("reason", reason));
    }
    @Override protected void handleOnResume() { foreground = true; }
    @Override protected void handleOnPause() { foreground = false; stopCapture("background"); }
    @Override protected void handleOnDestroy() {
        stopCapture("background");
        cameraHandler.post(() -> cameraThread.quitSafely());
        network.shutdown();
        if (Build.VERSION.SDK_INT >= 29 && thermalListener != null)
            getContext().getSystemService(PowerManager.class).removeThermalStatusListener(thermalListener);
    }

    private static String timestampNow() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }
    private static byte[] boundedRead(InputStream input, int limit) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int read;
        while ((read = input.read(buffer)) != -1) {
            if (out.size() + read > limit) throw new IllegalStateException("Response too large");
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }
    private static byte[] readBytes(File file) throws Exception {
        try (InputStream input = new java.io.FileInputStream(file)) { return boundedRead(input, 4 * 1024 * 1024); }
    }
    private static void writeBytes(File file, byte[] data) throws Exception {
        try (java.io.OutputStream output = new java.io.FileOutputStream(file)) { output.write(data); }
    }
    @PluginMethod public void discardFrame(PluginCall call) {
        Integer id = call.getInt("clientFrameId");
        if (id == null || id < 0) { call.reject("A valid clientFrameId is required", "MISSING"); return; }
        cameraHandler.post(() -> { deleteFrame(id); call.resolve(new JSObject().put("deleted", true)); });
    }

    private File framesDirectory() {
        // noBackupFilesDir is private to the app and excluded from Android backup.
        File dir = new File(getContext().getNoBackupFilesDir(), "captured-frames"); dir.mkdirs(); return dir;
    }
    private synchronized List<JSObject> storedFrames() {
        File[] files = framesDirectory().listFiles((dir, name) -> name.endsWith(".json"));
        List<JSObject> frames = new ArrayList<>();
        if (files != null) for (File file : files) {
            try { frames.add(new JSObject(new String(readBytes(file), StandardCharsets.UTF_8))); } catch (Exception ignored) { }
        }
        frames.sort(Comparator.comparingInt(frame -> frame.optInt("client_frame_id")));
        return frames;
    }
    private synchronized JSObject storeFrame(Bitmap source, JSObject meta) {
        double scale = Math.min(1, MAX_SIDE / (double) Math.max(source.getWidth(), source.getHeight()));
        Bitmap image = Bitmap.createScaledBitmap(source, Math.max(1, (int) (source.getWidth() * scale)), Math.max(1, (int) (source.getHeight() * scale)), true);
        ByteArrayOutputStream data = new ByteArrayOutputStream(); image.compress(Bitmap.CompressFormat.JPEG, 90, data);
        int id = nextFrameId++;
        JSObject record = meta.put("client_frame_id", id).put("width", image.getWidth()).put("height", image.getHeight())
            .put("bytes", data.size()).put("quality", quality(image));
        try {
            writeBytes(new File(framesDirectory(), id + ".jpg"), data.toByteArray());
            writeBytes(new File(framesDirectory(), id + ".json"), record.toString().getBytes(StandardCharsets.UTF_8));
            List<JSObject> all = storedFrames();
            for (int i = 0; i < all.size() - MAX_FRAMES; i++) deleteFrame(all.get(i).optInt("client_frame_id"));
            Bitmap thumb = Bitmap.createScaledBitmap(image, Math.max(1, image.getWidth() * 3 / 10), Math.max(1, image.getHeight() * 3 / 10), true);
            ByteArrayOutputStream preview = new ByteArrayOutputStream(); thumb.compress(Bitmap.CompressFormat.JPEG, 50, preview);
            record = new JSObject(record.toString()).put("preview", "data:image/jpeg;base64," + Base64.encodeToString(preview.toByteArray(), Base64.NO_WRAP));
            if (thumb != image) thumb.recycle();
            return record;
        } catch (Exception error) { deleteFrame(id); return null; }
        finally { if (image != source) image.recycle(); }
    }
    private JSObject quality(Bitmap image) {
        int width = Math.max(3, image.getWidth() * 64 / Math.max(image.getWidth(), image.getHeight()));
        int height = Math.max(3, image.getHeight() * 64 / Math.max(image.getWidth(), image.getHeight()));
        Bitmap small = Bitmap.createScaledBitmap(image, width, height, true);
        int[] pixels = new int[width * height]; small.getPixels(pixels, 0, width, 0, 0, width, height);
        double[] luma = new double[pixels.length]; double sum = 0, lapSum = 0, lapSquare = 0; int count = 0;
        for (int i = 0; i < pixels.length; i++) {
            luma[i] = 0.299 * ((pixels[i] >> 16) & 255) + 0.587 * ((pixels[i] >> 8) & 255) + 0.114 * (pixels[i] & 255); sum += luma[i];
        }
        for (int y = 1; y < height - 1; y++) for (int x = 1; x < width - 1; x++) {
            int i = y * width + x; double lap = luma[i - 1] + luma[i + 1] + luma[i - width] + luma[i + width] - 4 * luma[i];
            lapSum += lap; lapSquare += lap * lap; count++;
        }
        double mean = sum / pixels.length; double blur = lapSquare / count - Math.pow(lapSum / count, 2);
        JSArray flags = new JSArray(); if (blur < 30) flags.put("blurry"); if (mean < 40) flags.put("underexposed"); if (mean > 225) flags.put("overexposed");
        if (small != image) small.recycle();
        return new JSObject().put("mean_luma", Math.round(mean * 10) / 10.0).put("blur_score", Math.round(blur * 10) / 10.0)
            .put("flags", flags).put("method", "device-heuristic-64px");
    }
    private void deleteFrame(int id) {
        new File(framesDirectory(), id + ".jpg").delete(); new File(framesDirectory(), id + ".json").delete();
    }
    @PluginMethod public void listFrames(PluginCall call) { call.resolve(new JSObject().put("frames", new JSArray(storedFrames()))); }
    @PluginMethod public void deleteFrames(PluginCall call) {
        cameraHandler.post(() -> {
            List<JSObject> frames = storedFrames(); for (JSObject frame : frames) deleteFrame(frame.optInt("client_frame_id"));
            call.resolve(new JSObject().put("deleted", frames.size()));
        });
    }
    @PluginMethod public void readFrame(PluginCall call) {
        Integer id = call.getInt("clientFrameId");
        if (id == null || id < 0) { call.reject("A valid clientFrameId is required", "MISSING"); return; }
        cameraHandler.post(() -> {
            try {
                byte[] bytes = readBytes(new File(framesDirectory(), id + ".jpg"));
                call.resolve(new JSObject().put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)));
            } catch (Exception error) { call.reject("Frame is no longer stored", "MISSING"); }
        });
    }
    @PluginMethod public void importVideo(PluginCall call) {
        stopCapture("user");
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("video/*").addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(call, intent, "videoPicked");
    }
    @ActivityCallback private void videoPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject().put("frames", 0).put("cancelled", true)); return;
        }
        Uri uri = result.getData().getData(); double fps = Math.min(5, Math.max(0.5, call.getDouble("fps", 1.0)));
        cameraHandler.post(() -> {
            MediaMetadataRetriever retriever = new MediaMetadataRetriever();
            try {
                retriever.setDataSource(getContext(), uri);
                double duration = Double.parseDouble(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)) / 1000;
                int count = 0; double t = 0;
                for (; t < duration && count < MAX_VIDEO_FRAMES; t += 1 / fps) {
                    Bitmap frame = retriever.getFrameAtTime(Math.round(t * 1_000_000), MediaMetadataRetriever.OPTION_CLOSEST);
                    if (frame == null) continue;
                    JSObject meta = new JSObject().put("timestamp_s", t).put("captured_at", timestampNow())
                        .put("source", "video").put("orientation", "unknown");
                    JSObject event = storeFrame(frame, meta); frame.recycle();
                    if (event != null) { notifyListeners("frame", event); count++; }
                }
                call.resolve(new JSObject().put("frames", count).put("duration_s", duration).put("truncated", t < duration));
            } catch (Exception error) { call.reject("Could not read the selected video", "VIDEO"); }
            finally { try { retriever.release(); } catch (Exception ignored) { } }
        });
    }

    // Development transport stays native. The secret is encrypted with Android Keystore.
    private SharedPreferences preferences() { return getContext().getSharedPreferences("placematch-dev", 0); }
    private SecretKey tokenKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        String alias = "snapway-placematch-dev";
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    private String token() throws Exception {
        String encrypted = preferences().getString("token", null), iv = preferences().getString("iv", null);
        if (encrypted == null || iv == null) return null;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, tokenKey(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }
    @PluginMethod public void getDevConfig(PluginCall call) {
        if (!debugBuild()) { call.resolve(new JSObject().put("available", false)); return; }
        boolean hasToken = false; try { hasToken = token() != null; } catch (Exception ignored) { }
        call.resolve(new JSObject().put("available", true).put("baseUrl", preferences().getString("base", ""))
            .put("mode", preferences().getString("mode", "engine")).put("hasToken", hasToken));
    }
    @PluginMethod public void setDevConfig(PluginCall call) {
        if (!debugBuild()) { call.reject("Development settings are unavailable in release builds", "RELEASE"); return; }
        try {
            String base = call.getString("baseUrl", "").trim().replaceAll("/+$", "");
            URI uri = new URI(base);
            boolean local = "localhost".equals(uri.getHost()) || "127.0.0.1".equals(uri.getHost());
            if (uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null ||
                !("https".equals(uri.getScheme()) || ("http".equals(uri.getScheme()) && local))) throw new IllegalArgumentException();
            SharedPreferences.Editor edit = preferences().edit().putString("base", base)
                .putString("mode", "snapway".equals(call.getString("mode")) ? "snapway" : "engine");
            String secret = call.getString("token");
            if (secret != null && !secret.isEmpty()) {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, tokenKey());
                edit.putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
                edit.putString("token", Base64.encodeToString(cipher.doFinal(secret.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
            }
            edit.apply(); call.resolve(new JSObject().put("saved", true).put("hasToken", token() != null));
        } catch (Exception error) { call.reject("Use an HTTPS address (HTTP only for localhost)", "CONFIG"); }
    }
    @PluginMethod public void clearDevConfig(PluginCall call) { preferences().edit().clear().apply(); call.resolve(new JSObject().put("cleared", true)); }
    private void send(PluginCall call, String enginePath, String snapwayPath, byte[] body, String contentType, boolean binary) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            long started = System.nanoTime();
            try {
                if (!debugBuild() || token() == null) { call.reject("Set the server address and token in debug settings first", "CONFIG"); return; }
                String base = preferences().getString("base", "");
                if (base.isEmpty()) { call.reject("Set the server address in debug settings first", "CONFIG"); return; }
                String path = "snapway".equals(preferences().getString("mode", "engine")) ? snapwayPath : enginePath;
                connection = (HttpURLConnection) new URL(base + path).openConnection();
                connection.setInstanceFollowRedirects(false); // Never forward bearer credentials to another origin.
                connection.setConnectTimeout(15000); connection.setReadTimeout(60000);
                connection.setRequestProperty("Authorization", "Bearer " + token());
                connection.setRequestProperty("ngrok-skip-browser-warning", "true");
                if (body != null) {
                    connection.setRequestMethod("POST"); connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", contentType);
                    try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body); }
                }
                int status = connection.getResponseCode(); byte[] data;
                try (InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
                    data = input == null ? new byte[0] : boundedRead(input, 4 * 1024 * 1024);
                }
                JSObject response = new JSObject().put("status", status).put("roundTripMs", (System.nanoTime() - started) / 1_000_000);
                response.put(binary && status == 200 ? "dataUrl" : "body", binary && status == 200
                    ? "data:image/jpeg;base64," + Base64.encodeToString(data, Base64.NO_WRAP) : new String(data, StandardCharsets.UTF_8));
                call.resolve(response);
            } catch (Exception error) { call.reject("Cannot reach photo matching. Check the server and connection.", "NETWORK"); }
            finally { if (connection != null) connection.disconnect(); }
        });
    }
    @PluginMethod public void testConnection(PluginCall call) { send(call, "/v1/health", "/api/navigation/localize/health/", null, null, false); }
    @PluginMethod public void fetchThumbnail(PluginCall call) {
        String set = Uri.encode(call.getString("referenceSet", "")), ref = Uri.encode(call.getString("referenceId", ""));
        send(call, "/v1/references/" + set + "/thumb/" + ref, "/api/navigation/localize/references/" + set + "/thumb/" + ref, null, null, true);
    }
    @PluginMethod public void uploadFrame(PluginCall call) {
        Integer id = call.getInt("clientFrameId");
        if (id == null || id < 0) { call.reject("A valid clientFrameId is required", "MISSING"); return; }
        cameraHandler.post(() -> {
            try {
                byte[] jpeg = readBytes(new File(framesDirectory(), id + ".jpg"));
                JSObject meta = new JSObject(new String(readBytes(new File(framesDirectory(), id + ".json")), StandardCharsets.UTF_8));
                JSObject uploadMeta = new JSObject();
                for (String key : new String[] {"client_frame_id", "timestamp_s", "captured_at", "orientation", "source"}) uploadMeta.put(key, meta.get(key));
                String backend = call.getString("backend", "auto");
                if (!Arrays.asList("auto", "megaloc", "vertex").contains(backend)) backend = "auto";
                String query = "?backend=" + backend + "&verify=" + call.getBoolean("verify", false) + "&second_opinion=" + call.getBoolean("secondOpinion", false);
                String boundary = "snapway-" + UUID.randomUUID();
                ByteArrayOutputStream body = new ByteArrayOutputStream();
                body.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"meta\"\r\nContent-Type: application/json\r\n\r\n" + uploadMeta + "\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"image\"; filename=\"frame.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                body.write(jpeg); body.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
                send(call, "/v1/match" + query, "/api/navigation/localize/" + query, body.toByteArray(), "multipart/form-data; boundary=" + boundary, false);
            } catch (Exception error) { call.reject("Frame is no longer stored", "MISSING"); }
        });
    }
}
