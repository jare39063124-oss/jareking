/**
 * 渲染层平台差异（**快捷键主修饰键唯一来源**）。
 *
 * 背景（交接文档 §7.2 第 6 条）：Windows 用 Ctrl，macOS 用 Command（⌘）。
 * 旧代码里 `if (e.ctrlKey)` 有 5 处硬编码，在 macOS 上全部失效（⌘F 打不开查找条、
 * ⌘⇧P 唤不出命令面板、⌘1 不弹单元格格式、⌘F1 不折叠功能区）。
 *
 * 规则（铁律 1.1 单一来源）：
 *  - 判定逻辑只在**本文件**：`isPrimaryModifier` / `hasPrimaryModifier`；
 *  - 文案统一走 `accelLabel` / `primaryModifierLabel`，禁止在组件里手写 'Ctrl+F'；
 *  - 平台来源：preload 透出的 `window.jareking.platform`（`process.platform` 原值），
 *    **不用** `navigator.platform` / UA 嗅探（已废弃且被 UA 冻结策略弱化）。
 *  - 单测 / jsdom 环境下 `window.jareking` 可能不存在 → 回落到 UA 探测，保证不抛错。
 */

/** 是否 macOS（渲染层判定，模块加载时求值一次） */
export const isMac: boolean = detectMac();

/** 内部：优先用 preload 透出的 process.platform，缺失时回落 UA（仅测试/浏览器预览） */
function detectMac(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    // 防御式取用：移动端（apps/mobile）以 `@renderer/*` 复用本目录源码，
    // 其 `window.jareking` 是另一套 Capacitor 桥的 shim，未必同步声明 platform。
    // 这里用结构化窄化而非直接依赖 JarekingApi 字段，避免跨端 shim 未同步就编译失败。
    const bridge = window.jareking as { platform?: string } | undefined;
    if (bridge?.platform) return bridge.platform === 'darwin';
  } catch {
    /* window.jareking 访问异常（极早期/测试桩）时走回落 */
  }
  if (typeof navigator === 'undefined') return false;
  return /mac/i.test(navigator.userAgent);
}

/**
 * 事件是否按下了「主修饰键」（mac = ⌘，其余 = Ctrl）。
 *
 * 注意：macOS 上**不**把 Ctrl 当作主修饰键——Ctrl 在 mac 是 Emacs 风格的光标移动键，
 * 误判会导致编辑器的 Ctrl+A / Ctrl+E 快捷键被应用吞掉。
 */
export function hasPrimaryModifier(event: {
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return isPrimaryModifierOn(event, isMac);
}

/**
 * `hasPrimaryModifier` 的纯函数版本（平台由参数传入，便于单测覆盖两条分支）。
 *
 * 生产代码请用 `hasPrimaryModifier`；本函数仅供测试与极端场景（如需要显式指定平台）使用。
 */
export function isPrimaryModifierOn(
  event: { ctrlKey: boolean; metaKey: boolean },
  mac: boolean,
): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}

/** 主修饰键的可读符号（mac = ⌘，其余 = Ctrl） */
export function primaryModifierLabel(): string {
  return primaryModifierLabelOn(isMac);
}

/** `primaryModifierLabel` 的纯函数版本（显式指定平台） */
export function primaryModifierLabelOn(mac: boolean): string {
  return mac ? '⌘' : 'Ctrl';
}

/**
 * 组合快捷键文案，如 `accelLabel('F')` → mac `⌘F` / Windows `Ctrl+F`。
 *
 * @param key      主键（如 'F' / 'H' / '1' / 'F1' / 'Enter'）
 * @param shift    是否需要 Shift（mac 用 ⇧，Windows 用 Shift+）
 * @param others   附加修饰键（如 'Alt'），按实际平台映射符号
 */
export function accelLabel(key: string, shift = false, others: string[] = []): string {
  return accelLabelOn(key, isMac, shift, others);
}

/** `accelLabel` 的纯函数版本（显式指定平台，便于单测） */
export function accelLabelOn(
  key: string,
  mac: boolean,
  shift = false,
  others: string[] = [],
): string {
  if (mac) {
    const modifierSymbols: Record<string, string> = { Alt: '⌥', Shift: '⇧', Ctrl: '⌃' };
    const prefix = [shift ? '⇧' : '', ...others.map((o) => modifierSymbols[o] ?? o)].join('');
    return `⌘${prefix}${key}`;
  }
  const parts = ['Ctrl', ...(shift ? ['Shift'] : []), ...others];
  return `${parts.join('+')}+${key}`;
}
