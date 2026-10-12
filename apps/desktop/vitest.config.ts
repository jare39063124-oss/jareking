/**
 * vitest 配置（桌面渲染层单元测试，不依赖 electron-vite）。
 * 仅用于测试渲染进程内的纯逻辑模块（jkToHtml / htmlToJk / 文档转换）。
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // 指向 writer 源码，避免依赖打包后的 dist 产生滞后
      '@jareking/writer': fileURLToPath(
        new URL('../../packages/writer/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/renderer/src/**/*.test.ts'],
  },
});
