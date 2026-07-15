/**
 * Electron API Type Declarations
 * Types for the APIs exposed via contextBridge
 */
import type { ConversationTimelineMode } from '../../shared/conversation-rollout';

export interface IpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: (...args: unknown[]) => void): (() => void) | void;
  once(channel: string, callback: (...args: unknown[]) => void): void;
  off(channel: string, callback?: (...args: unknown[]) => void): void;
}

export interface ElectronAPI {
  ipcRenderer: IpcRenderer;
  openExternal: (url: string) => Promise<void>;
  getPathForFile: (file: File) => string;
  platform: NodeJS.Platform;
  isDev: boolean;
  chatTimelineModeOverride: ConversationTimelineMode | null;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
