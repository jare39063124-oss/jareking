# macOS 版交付概览（2026-10-17）

## 一句话结论

macOS 版的**代码级适配已全部落地并验证**（desktop 单测 250 → 277、全量构建通过、GUI 冒烟零报错、Windows 行为零回归）；
**唯一边界是物理限制**：dmg 产物必须在 macOS 或 CI 上生成，本机（Windows）做不到。

## 做了什么

| 方向 | 结果 |
|---|---|
| 平台适配层 | 新建 `apps/desktop/src/main/platform/`，`process.platform` 收口到单一文件；Office→PDF 拆成门面 + Win（COM）/ mac（LibreOffice headless）双实现 |
| macOS 生命周期 | `open-file` 顶层注册（冷启动早于 ready）、argv 噪声过滤（含 `-psn_xxx`）、`window-all-closed` 不退出、`activate` 重建窗口 |
| **应用菜单（P0）** | 仅 mac 安装标准 role 菜单 —— 这是 ⌘C/⌘V/⌘Z/⌘A/⌘Q 的唯一载体，缺了等于全应用复制粘贴失效 |
| 双击关联文件 | 新增 IPC `doc:pending:take` + 渲染层 `lib/pendingFiles.ts`，走既有「待打开 + 新建标签」链路直达编辑器 |
| 快捷键 | 清掉 5 处 `e.ctrlKey` 硬编码（⌘⇧P / ⌘F / ⌘H / ⌘Enter / ⌘1 / ⌘F1）+ 全部 `Ctrl+` 文案改为 `accelLabel()` |
| 打包 | `electron-builder.yml` 加 mac（dmg + **zip**，x64 + arm64 分别出包）；entitlements 逐条注释理由；签名配置不写死（有证书自动发现） |
| 产包路径 | `.github/workflows/macos-build.yml`（macos-14，未签名/签名双路径）+ `scripts/package-mac.sh`（mac 本机） |
| 文档 | spec v1.2 平台改为 Windows + macOS；新增平台耦合清单、发布指南、todo M 系列、AGENTS 新铁律 1.6.1 |

## 验证结果

| 门禁 | 结果 |
|---|---|
| `pnpm --filter @jareking/desktop typecheck` | EXIT 0 |
| desktop 单测 | **277 passed**（基线 250，+27 新增） |
| 全量构建（`CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm build`） | EXIT 0 |
| GUI 冒烟（真实 Electron + CDP） | **通过，consoleErrors 为空** |
| 其它包 | writer 58 / presentation 52 / core 87 / sheet 65 / pdf 15 / ai 16 全绿 |

## 已知边界（不美化）

1. **dmg 出不来**：必须 macOS 或 GitHub Actions。工作流已就位，推到 GitHub 手动 Run 一次即可拿到首个包。
2. **未签名包会被 Gatekeeper 拦**：需右键打开或 `xattr -dr com.apple.quarantine`；正式分发要 Apple Developer($99/年) + 公证。
3. **Office→PDF 在 mac 依赖 LibreOffice**：未安装时给明确中文提示（不假装成功）；产品上可降级为只留三模块「导出 PDF」。
4. **字体差异不可代码消除**：mac 无宋体/黑体同名文件，导出 PDF 字形与 Windows 必有差异，需视觉验收定标准。
5. **mac 自动更新需签名**后才真正可用（Squirrel.Mac 限制）。
6. **技术债**：`apps/mobile` 用 `@renderer/*` 反向引用 desktop 渲染层源码，desktop 渲染层任何改动都可能打挂移动端 typecheck（本轮已踩到，已做防御式处理）。

## 下一步（按优先级）

1. 推到 GitHub → Actions 跑 `macOS build` → 拿首个 dmg → 装到真机过 M5 验收清单
2. M5.4 字体视觉验收（决定是否切 OFL 字体做跨端一致）
3. 有对外分发需求时再上 Apple Developer + 公证（M6）
4. `resources/icon.icns` 与 macOS「文件」菜单（需主进程→渲染层命令通道，M7.2）
