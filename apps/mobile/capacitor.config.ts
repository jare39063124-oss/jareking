import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 配置。
 *
 * - `androidScheme: 'https'`：让 WebView 以 `https://localhost` 载入页面，
 *   从而获得 **secure context**（Web Crypto、Clipboard、Service Worker 等能力的前提）；
 * - `webDir` 指向 Vite 产物 `dist`，`cap sync` 会整体拷进 Android assets；
 * - 不引入任何原生插件之外的第三方依赖（体积敏感）。
 */
const config: CapacitorConfig = {
  appId: 'cn.jareking.app',
  appName: 'jareking',
  webDir: 'dist',
  android: {
    // 允许在 Chrome DevTools 里远程调试 WebView（发布前可关闭）
    webContentsDebuggingEnabled: true,
    // 表格/演示用 canvas 大量绘制，开启硬件加速（默认即开）
    backgroundColor: '#f5f6f8',
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
