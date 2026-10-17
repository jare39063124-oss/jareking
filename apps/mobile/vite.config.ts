import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

const rendererSrc = resolve(__dirname, '../desktop/src/renderer/src');
const shims = resolve(__dirname, 'src/platform/shims');

/**
 * Android / Web 构建配置。
 *
 * 复用策略：渲染层源码不复制、不改写——直接以 `@renderer` 别名指向
 * `apps/desktop/src/renderer/src`，让 Windows 版与移动版共用同一份 UI/编辑器代码。
 * 平台差异只存在于 `window.jareking` 的实现层（src/platform）。
 *
 * Node 内置模块在 WebView 中不存在：桌面端的持久层（sql.js + node:fs）在移动端
 * 由 IndexedDB 实现替代，因此这里用 shim 顶替，避免打包期解析失败。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@renderer', replacement: rendererSrc },
      { find: '@mobile', replacement: resolve(__dirname, 'src') },
      // 通道名单一事实源在 desktop（铁律 1.1：不许复制一份）
      { find: '@ipc', replacement: resolve(__dirname, '../desktop/src/ipc/channels.ts') },
      { find: /^node:fs\/promises$/, replacement: resolve(shims, 'fs-promises.ts') },
      { find: /^node:fs$/, replacement: resolve(shims, 'fs.ts') },
      { find: /^node:path$/, replacement: resolve(shims, 'path.ts') },
      { find: /^node:crypto$/, replacement: resolve(shims, 'crypto.ts') },
      { find: /^node:os$/, replacement: resolve(shims, 'noop.ts') },
      { find: /^sql\.js$/, replacement: resolve(shims, 'sqljs.ts') },
    ],
  },
  // 与桌面版一致：允许 `import x from '...docx?url'` 这类静态资源引用
  assetsInclude: ['**/*.docx'],
  define: {
    // 部分依赖会读 process.env.NODE_ENV
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'process.env': '{}',
    global: 'globalThis',
  },
  build: {
    // Capacitor 从 webDir 直接拷贝静态资源，无需 sourcemap
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      output: {
        // 大依赖单独分包，便于 WebView 首屏并行加载与定位体积来源
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@univerjs') || id.includes('/univer')) return 'univer';
          if (id.includes('pdfjs-dist')) return 'pdfjs';
          if (id.includes('konva')) return 'konva';
          if (id.includes('@tiptap') || id.includes('prosemirror')) return 'tiptap';
          if (id.includes('exceljs')) return 'exceljs';
          return 'vendor';
        },
      },
    },
  },
  server: { port: 5199, host: '127.0.0.1' },
  // WebView 下 Univer/TipTap 的依赖预构建会显著拖慢首启，保持默认即可
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});
