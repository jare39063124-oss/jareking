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
    // 渲染层纯逻辑测试 + 主/渲染共用的 shared 纯函数测试（如 officePdfScript）
    // + 主进程纯函数测试（platform 适配层，文件内用 `@vitest-environment node` 声明环境）
    include: [
      'src/renderer/src/**/*.test.ts',
      'src/shared/**/*.test.ts',
      'src/main/**/*.test.ts',
    ],
  },
});
