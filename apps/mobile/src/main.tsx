/**
 * 移动端入口。
 *
 * 顺序要求：`./platform` 必须在 `@renderer/App` 之前求值——
 * renderer 的 store（aiStore / macroStore / aiMeteringStore）在模块顶层读取
 * `window.jareking.IPC`，桥未安装会直接抛错。ESM 按 import 顺序求值，满足该约束。
 */
import './platform';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@renderer/App';
import './assets/mobile.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
