#!/usr/bin/env node
/**
 * Android APK 构建脚本。
 *
 * 职责：把「环境变量 + SDK 路径 + gradle 调用」收敛到一处，
 * 避免每次手动拼 JAVA_HOME / ANDROID_SDK_ROOT / local.properties。
 *
 * 用法：
 *   node scripts/build-apk.mjs            # debug APK
 *   node scripts/build-apk.mjs --release  # release（未签名，正式分发需自备 keystore）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, '..');
const androidDir = join(appDir, 'android');

/** 工具链位置：优先环境变量，其次本项目受管目录（C:\Users\<user>\.workbuddy\binaries） */
const home = os.homedir();
const binDir = join(home, '.workbuddy', 'binaries');
// Capacitor 7（AGP 8.7 的插件子模块）声明了 Java 21 toolchain：
// 用 JDK 17 会报 "No locally installed toolchains match ... languageVersion=21"。
const JdkCandidates = [join(binDir, 'jdk-21'), join(binDir, 'jdk-17')];
const JAVA_HOME =
  process.env.JAVA_HOME ?? JdkCandidates.find((p) => existsSync(join(p, 'bin', 'java.exe'))) ?? JdkCandidates[0];
const SDK_ROOT =
  process.env.ANDROID_SDK_ROOT ??
  process.env.ANDROID_HOME ??
  join(home, '.workbuddy', 'binaries', 'android-sdk');

function fail(msg) {
  console.error(`\n[build-apk] ✗ ${msg}\n`);
  process.exit(1);
}

if (!existsSync(androidDir)) {
  fail(`未找到 android 工程：${androidDir}\n  请先执行：pnpm --filter @jareking/mobile exec cap add android`);
}
if (!existsSync(join(JAVA_HOME, 'bin', 'java.exe')) && !existsSync(join(JAVA_HOME, 'bin', 'java'))) {
  fail(`JDK 不存在：${JAVA_HOME}（设置 JAVA_HOME 指向 JDK 17）`);
}
if (!existsSync(SDK_ROOT)) fail(`Android SDK 不存在：${SDK_ROOT}`);

// gradle 需要 local.properties 指到 SDK
writeFileSync(
  join(androidDir, 'local.properties'),
  `# 由 scripts/build-apk.mjs 自动生成\nsdk.dir=${SDK_ROOT.replace(/\\/g, '/')}\n`,
  'utf8',
);

const release = process.argv.includes('--release');
const task = release ? 'assembleRelease' : 'assembleDebug';
const isWin = process.platform === 'win32';
const gradlew = isWin ? join(androidDir, 'gradlew.bat') : join(androidDir, 'gradlew');

console.log(`[build-apk] JAVA_HOME=${JAVA_HOME}`);
console.log(`[build-apk] SDK=${SDK_ROOT}`);
console.log(`[build-apk] task=${task}`);

try {
  execFileSync(isWin ? 'cmd.exe' : gradlew, isWin ? ['/c', gradlew, task, '--no-daemon'] : [task, '--no-daemon'], {
    cwd: androidDir,
    stdio: 'inherit',
    env: { ...process.env, JAVA_HOME, ANDROID_SDK_ROOT: SDK_ROOT, ANDROID_HOME: SDK_ROOT },
  });
} catch {
  fail('gradle 构建失败（见上方日志）');
}

const variant = release ? 'release' : 'debug';
const apk = join(androidDir, 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
if (!existsSync(apk)) fail(`构建成功但未找到 APK：${apk}`);

const mb = (statSync(apk).size / 1024 / 1024).toFixed(1);
console.log(`\n[build-apk] ✓ APK: ${apk}`);
console.log(`[build-apk] 体积: ${mb} MB\n`);
