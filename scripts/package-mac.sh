#!/usr/bin/env bash
#
# jareking — macOS 本机打包脚本（**必须在 macOS 上执行**）
#
# 为什么单独写脚本而不是直接用 pnpm package:mac：
#   1. 前置环境自检（Xcode Command Line Tools / hdiutil / 架构 / 磁盘空间）——
#      这些缺失时报错信息极其晦涩（例如 codesign 报 "unable to build chain"）；
#   2. 可选签名/公证分支：同一脚本覆盖「内测未签名」与「正式已签名」两种产出，
#      避免两套命令在文档里各自漂移；
#   3. 产出后打印实际体积（本项目对体积高度敏感，必须每次可见）。
#
# 用法（macOS 终端）：
#   bash scripts/package-mac.sh              # 未签名内测包（默认）
#   JK_SIGN=1 bash scripts/package-mac.sh    # 签名 + 公证（需证书与公证凭据，见下）
#
# 签名所需环境变量（JK_SIGN=1 时）：
#   CSC_LINK / CSC_KEY_PASSWORD                   Developer ID Application 证书 .p12（路径或 base64）
#   APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID   公证凭据
#
set -euo pipefail

# ── 0. 平台自检：不是 macOS 直接退出（Windows 上跑永远拿不到可用 dmg）────────────
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "✗ 本脚本只能在 macOS 上运行（当前系统：$(uname -s)）。" >&2
  echo "  Windows 上请改用：GitHub Actions 工作流 .github/workflows/macos-build.yml" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ARCH="$(uname -m)"
echo "==> jareking macOS 打包"
echo "    仓库：$REPO_ROOT"
echo "    主机架构：$ARCH"
echo "    签名：$([[ "${JK_SIGN:-0}" == "1" ]] && echo '开启（签名 + 公证）' || echo '关闭（未签名内测包）')"

# ── 1. 工具链自检 ────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || { echo "✗ 未找到 node（需 22.x）" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "✗ 未找到 pnpm（需 12.x，可用 corepack enable 启用）" >&2; exit 1; }
command -v hdiutil >/dev/null 2>&1 || { echo "✗ 未找到 hdiutil（Xcode Command Line Tools 缺失，执行 xcode-select --install）" >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" != "22" ]]; then
  echo "⚠ Node 主版本为 $NODE_MAJOR，本项目基线是 22.x（其它版本未验证）" >&2
fi

# 磁盘剩余空间（dmg + zip 双架构约需 3~4GB）
FREE_GB="$(df -g "$REPO_ROOT" | awk 'NR==2 {print $4}')"
if [[ -n "${FREE_GB:-}" && "$FREE_GB" -lt 5 ]]; then
  echo "⚠ 剩余磁盘空间 ${FREE_GB}GB，双架构打包建议 ≥5GB" >&2
fi

# ── 2. 依赖与编译 ────────────────────────────────────────────────────────────
echo "==> 安装依赖"
pnpm install --frozen-lockfile

echo "==> 类型检查 + 单测（门禁，失败即停）"
pnpm typecheck
pnpm test

echo "==> 编译 main / preload / renderer"
CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm build

# ── 3. 打包 ──────────────────────────────────────────────────────────────────
echo "==> 打包 dmg + zip（x64 + arm64）"
if [[ "${JK_SIGN:-0}" == "1" ]]; then
  : "${CSC_LINK:?JK_SIGN=1 需要 CSC_LINK（.p12 路径或 base64）}"
  : "${CSC_KEY_PASSWORD:?JK_SIGN=1 需要 CSC_KEY_PASSWORD}"
  if [[ -z "${APPLE_ID:-}" || -z "${APPLE_TEAM_ID:-}" || -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
    echo "⚠ 未提供完整公证凭据（APPLE_ID / APPLE_TEAM_ID / APPLE_APP_SPECIFIC_PASSWORD）" >&2
    echo "  将产出「已签名但未公证」的包：用户首次打开仍会被 Gatekeeper 拦截" >&2
  fi
  pnpm --filter @jareking/desktop package:mac
else
  # 无证书环境：显式关闭自动发现，让 electron-builder 跳过签名而不是硬失败
  CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @jareking/desktop package:mac
fi

# ── 4. 产出清单与体积（体积敏感：每次必须可见）───────────────────────────────
echo
echo "==> 产物（apps/desktop/release/）"
ls -lh apps/desktop/release/*.dmg apps/desktop/release/*.zip 2>/dev/null || {
  echo "✗ 未找到 dmg/zip 产物，请检查上方 electron-builder 日志" >&2
  exit 1
}

echo
echo "==> 签名与公证校验"
APP_PATH="$(find apps/desktop/release -maxdepth 2 -name '*.app' -type d | head -1 || true)"
if [[ -n "$APP_PATH" ]]; then
  if codesign -dv "$APP_PATH" >/dev/null 2>&1; then
    echo "    签名状态：已签名"
    codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1 | sed 's/^/    /' || true
  else
    echo "    签名状态：未签名（内测包）。首次打开需右键→打开，或执行："
    echo "      xattr -dr com.apple.quarantine \"$APP_PATH\""
  fi
  if spctl --assess --type execute --verbose "$APP_PATH" >/dev/null 2>&1; then
    echo "    Gatekeeper：已通过（公证生效）"
  else
    echo "    Gatekeeper：未通过（未公证属预期，正式分发必须补公证）"
  fi
fi

echo
echo "✓ 完成。dmg 用于人工安装，zip 供 electron-updater 自动更新使用（Squirrel.Mac 只吃 zip）。"
