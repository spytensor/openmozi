/// <reference types="vite/client" />

interface Window {
  moziDesktop?: {
    selectDirectory: () => Promise<{ canceled: boolean; path?: string }>;
    getBuildInfo?: () => Promise<{ version: string; surface: "desktop" }>;
  };
}
