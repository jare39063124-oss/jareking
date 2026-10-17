# macOS 发布指南（签名 · 公证 · 分发）

> 归属：macOS 版 · 2026-10-17
> 配套：`docs/macos-platform-matrix.md`（耦合清单）、`.github/workflows/macos-build.yml`（CI 产包）、`scripts/package-mac.sh`（本机产包）
> 一句话：**不签名的 dmg 能装但会被 Gatekeeper 拦；要「双击就开、自动更新可用」必须 Apple Developer 证书 + 公证。**

---

## 1. 三条产出路线（按投入排序）

| 路线 | 成本 | 产出 | 用户侧体验 | 适用阶段 |
|---|---|---|---|---|
| A. 未签名 | 0 | dmg/zip，`CSC_IDENTITY_AUTO_DISCOVERY=false` | 首次打开被拦，需**右键 → 打开**或 `xattr -dr com.apple.quarantine`；**自动更新不可用** | 内测 / 自己人试用 |
| B. 已签名未公证 | $99/年 | 已签名 dmg/zip | 仍可能被拦（公证是 Gatekeeper 的主判据）；自动更新可试 | 过渡，不建议对外 |
| C. 已签名 + 已公证 | $99/年 | dmg/zip + 公证票据已 staple | 双击即开；自动更新正常 | **正式分发唯一选择** |

> 说明：Apple 对 macOS 上「Developer ID 分发」的门槛是 $99/年 Apple Developer Program。个人开发者可申请，无需企业资质——这一点与项目「个人开发者、无企业主体」的约束**不冲突**。

---

## 2. 路线 A：未签名内测包（当前默认）

```bash
# macOS 终端，仓库根
bash scripts/package-mac.sh
# 或：CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @jareking/desktop package:mac
```

产物：`apps/desktop/release/jareking-<version>-x64.dmg` / `-arm64.dmg` 及同名 `.zip`、`.blockmap`。

拿到包的人首次打开：

```bash
# 方式一（推荐，最省事）：解除隔离标记
xattr -dr com.apple.quarantine /Applications/jareking.app

# 方式二：Finder 里右键 jareking.app → 打开 → 在弹窗里再点「打开」
# （首次之后不再询问）
```

或在 CI 手动触发：GitHub → Actions → **macOS build** → Run workflow → `sign = false`。

---

## 3. 路线 C：正式分发（签名 + 公证）

### 3.1 一次性准备

1. 加入 Apple Developer Program（$99/年），拿到 **Team ID**（10 位，形如 `A1B2C3D4E5`）。
2. 在 Apple Developer 后台 → Certificates → 新建 **Developer ID Application** 证书，导出 `.p12` 并设密码。
3. 生成**App 专用密码**（appleid.apple.com → 登录与安全 → App 专用密码），公证要用。
4. （CI 用）把 `.p12` 转 base64 存进仓库 Secrets：
   ```bash
   base64 -i DeveloperID.p12 | pbcopy   # 粘贴到 Secret MAC_CSC_LINK
   ```
   同时配 `MAC_CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`。

### 3.2 本机签名 + 公证

```bash
# macOS 终端，仓库根
export CSC_LINK="$HOME/certs/DeveloperID.p12"
export CSC_KEY_PASSWORD="<p12 密码>"
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="A1B2C3D4E5"
JK_SIGN=1 bash scripts/package-mac.sh
```

### 3.3 公证（两条路径，任选）

**路径 1：electron-builder 自动公证（推荐，省事）**

在 `apps/desktop/electron-builder.yml` 的 `mac:` 下增加：

```yaml
mac:
  # …已有配置…
  notarize:
    teamId: ${env.APPLE_TEAM_ID}
```

配合上面四个环境变量（`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`）即可。

> ⚠️ `notarize` 的具体字段随 electron-builder 版本演进（26.x 走 `@electron/notarize`）。落地前请以
> 当前安装版本的官方文档为准：`pnpm --filter @jareking/desktop exec electron-builder --help` 或
> <https://www.electron.build/mac>。**不要凭记忆写配置**。

**路径 2：手工 notarytool（最确定，出问题好排查）**

```bash
# 1) 打包（已签名，未公证）
JK_SIGN=1 bash scripts/package-mac.sh

# 2) 提交公证（zip 比 dmg 快且稳，Apple 推荐）
xcrun notarytool submit apps/desktop/release/jareking-*-arm64.zip \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

# 3) 若被拒，看日志定位（最常见：entitlements 过宽 / 有未签名嵌套二进制）
xcrun notarytool log <submission-id> --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID"

# 4) 公证通过后把票据钉进 app，否则离线机器仍会拦
xcrun stapler staple /Applications/jareking.app
xcrun stapler validate /Applications/jareking.app
```

### 3.4 验收（三条命令，全绿才算可分发）

```bash
codesign --verify --deep --strict --verbose=2 /Applications/jareking.app
spctl --assess --type execute --verbose /Applications/jareking.app   # 期望 accepted / source=Notarized Developer ID
xcrun stapler validate /Applications/jareking.app
```

---

## 4. entitlements 说明（`resources/entitlements.mac.plist`）

已在文件头逐条注释理由，摘要：

| 键 | 为什么必须 |
|---|---|
| `com.apple.security.cs.allow-jit` | V8 JIT，不给应用启动即崩 |
| `com.apple.security.cs.allow-unsigned-executable-memory` | V8/Chromium 优化路径 + sql.js 的 WebAssembly |
| `com.apple.security.cs.allow-dyld-environment-variables` | Electron 主进程加载 `.dylib` |
| `com.apple.security.cs.disable-library-validation` | 允许加载非同 Team ID 签名的库 |

**不要把 entitlements 当模板抄宽**：公证被拒最常见原因就是「申请了用不到的例外」。若将来移除某能力（如不再用 sql.js），应同步收窄此项并重跑验收（§4 验收清单 1/3/5 项）。

---

## 5. 自动更新（electron-updater）在 mac 上的前提

- Squirrel.Mac **只接受 zip**，所以 `electron-builder.yml` 里 `zip` target 不是可选项；
- **必须已签名**（未签名时 `autoUpdater` 报 code signature 相关错误，被 `updater.ts` 的 error 监听兜住，只打日志不弹框）；
- `publish` 目前指向 `provider: github / owner: jareking-office / repo: jareking`——**该仓库尚未创建**，正式启用前需确认 owner/repo 与实际落点一致（当前 Git 远端是 `jare39063124-oss/jareking`）。
- GitHub Releases 作为更新源对公开仓库免费；私有仓库需要 token（会给用户带来配置成本）。

---

## 6. CI（`.github/workflows/macos-build.yml`）行为

| 触发 | 签名 | 产出 |
|---|---|---|
| `workflow_dispatch` + `sign=false`（默认） | 否 | dmg/zip × x64/arm64 → artifact，保留 14 天 |
| `workflow_dispatch` + `sign=true` | 是（用 Secrets 里的证书/公证凭据） | 同上，已签名（是否公证取决于是否启用 `notarize`） |
| push `v*` tag | 按默认（未签名） | 同上 |

> 首次真正拿到 dmg 的动作：把仓库推到 GitHub → Actions 里手动 Run workflow。**Windows 本机无法产出 macOS 包**（electron-builder 依赖 `hdiutil` / `codesign` / `notarytool`），这条限制无法绕过。
