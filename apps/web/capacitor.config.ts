import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'org.snapway.app',
  appName: 'SnapWay',
  webDir: 'dist/snapway-visitor/browser',
  ios: {
    // Matches --canvas so launch and overscroll show no white flash.
    backgroundColor: '#f5f6f3',
  },
};

export default config;
