/// <reference types="vite/client" />

interface Window {
  jarekingAPI: {
    ping: () => Promise<string>
    window: {
      minimize: () => Promise<void>
      maximize: () => Promise<boolean>
      close: () => Promise<void>
      isMaximized: () => Promise<boolean>
    }
    file: {
      open: () => Promise<{ filePath: string; data: ArrayBuffer } | null>
      save: (data: ArrayBuffer, filePath?: string) => Promise<string | null>
      readByPath: (filePath: string) => Promise<ArrayBuffer>
    }
    recentFiles: {
      get: () => Promise<{ path: string; name: string }[]>
      clear: () => Promise<void>
    }
  }
}
