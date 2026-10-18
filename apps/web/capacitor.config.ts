import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'org.snapway.app',
  appName: 'SnapWay',
  webDir: 'dist/snapway-visitor/browser',
  plugins: {
    // Use the existing native HTTP bridge for HTTPS JSON and multipart frame uploads.
    // The bundled iOS origin is opaque; website CORS grants are not native transport auth.
    CapacitorHttp: { enabled: true },
  },
  ios: {
    // Matches --canvas so launch and overscroll show no white flash.
    backgroundColor: '#f5f6f3',
  },
};

export default config;
