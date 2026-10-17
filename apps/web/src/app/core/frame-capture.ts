import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { MatchBackend } from './place-match';

/** Native iOS frame capture (`ios/App/App/FrameCapturePlugin.swift`). */
export type CameraStatus = 'notDetermined' | 'authorized' | 'denied' | 'restricted';

export interface DeviceQuality {
  mean_luma?: number;
  blur_score?: number;
  flags: string[];
  method?: string;
}

export interface CapturedFrame {
  client_frame_id: number;
  timestamp_s: number;
  captured_at: string;
  orientation: string;
  source: 'camera' | 'video';
  width: number;
  height: number;
  bytes: number;
  quality: DeviceQuality;
  /** Small JPEG data URL for the on-screen preview only. */
  preview?: string;
}

export interface HttpResult {
  status: number;
  body?: string;
  dataUrl?: string;
  roundTripMs: number;
}

export interface DevConfig {
  available: boolean;
  baseUrl?: string;
  mode?: 'engine' | 'snapway';
  hasToken?: boolean;
}

export interface CaptureStatus {
  camera: CameraStatus;
  cameraAvailable: boolean;
  debugBuild: boolean;
  capturing: boolean;
  storedFrames: number;
}

export interface FrameCapturePlugin {
  getStatus(): Promise<CaptureStatus>;
  requestPermission(): Promise<{ camera: CameraStatus }>;
  openSettings(): Promise<{ opened: boolean }>;
  start(options: { fps: number }): Promise<{ capturing: boolean; fps: number }>;
  stop(): Promise<{ capturing: boolean }>;
  listFrames(): Promise<{ frames: CapturedFrame[] }>;
  deleteFrames(): Promise<{ deleted: number }>;
  importVideo(options: {
    fps: number;
  }): Promise<{ frames: number; duration_s?: number; truncated?: boolean; cancelled?: boolean }>;
  uploadFrame(options: {
    clientFrameId: number;
    backend: MatchBackend;
    verify: boolean;
    secondOpinion: boolean;
  }): Promise<HttpResult>;
  testConnection(): Promise<HttpResult>;
  fetchThumbnail(options: { referenceSet: string; referenceId: string }): Promise<HttpResult>;
  getDevConfig(): Promise<DevConfig>;
  setDevConfig(options: {
    baseUrl: string;
    mode: 'engine' | 'snapway';
    token?: string;
  }): Promise<{ saved: boolean; hasToken: boolean }>;
  clearDevConfig(): Promise<{ cleared: boolean }>;
  addListener(
    event: 'frame',
    listener: (frame: CapturedFrame) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'state',
    listener: (state: { capturing: boolean; reason: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const FrameCapture = registerPlugin<FrameCapturePlugin>('FrameCapture');

/** Real capture exists only inside the iOS app; the browser keeps the simulated flow. */
export function nativeCaptureAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}
