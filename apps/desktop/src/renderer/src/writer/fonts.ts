/**
 * 字体清单（版权合规版，见 docs/fonts.md）。
 *
 * 三组：系统字体（调用用户机器已有字体，不打包分发）/
 * OFL 开源（可随安装包内置分发）/ 厂商免费商用（用户自装后可用，v1 不打包）。
 * 未安装的字体浏览器按 fallback 渲染，但字体名会写入 docx——跨机器打开时系统有则正确显示。
 */

export interface FontGroup {
  label: string;
  /** 组内说明（下拉 title 提示） */
  note: string;
  fonts: string[];
}

export const FONT_GROUPS: FontGroup[] = [
  {
    label: '系统字体',
    note: '调用 Windows 系统字体（文件归系统所有，不随 jareking 分发）',
    fonts: ['宋体', '黑体', '微软雅黑', '楷体', '仿宋', '等线', 'Times New Roman', 'Arial', 'Calibri', 'Cambria'],
  },
  {
    label: '开源字体（OFL，将随 jareking 内置）',
    note: 'SIL OFL 1.1 协议，免费商用、可随安装包分发（docs/fonts.md）',
    fonts: ['思源黑体', '思源宋体', '霞鹜文楷', '得意黑', '朱雀仿宋', '抖音美好体'],
  },
  {
    label: '厂商免费商用（用户自装后可用）',
    note: '官方授权免费商用；未安装时按系统 fallback 渲染（docs/fonts.md 附官方下载源）',
    fonts: ['阿里巴巴普惠体', 'MiSans', 'HarmonyOS Sans', 'OPPO Sans', '站酷高端黑', '站酷快乐体', '京东朗正体'],
  },
];

/** 全部字体名（平铺，供查找/默认值校验） */
export const ALL_FONT_NAMES = FONT_GROUPS.flatMap((g) => g.fonts);

/**
 * 字数统计（对齐 WPS 口径）：
 * - 「字数」= 中日韩字符按 1 字计 + 连续西文/数字串按 1 词计；
 * - 「字符数」= 全部非空白字符数（不计空格）与含空格两档由调用方取用。
 */
export function countWords(text: string): { words: number; charsNoSpace: number; chars: number } {
  if (!text) return { words: 0, charsNoSpace: 0, chars: 0 };
  // 中日韩字符（含扩展A/兼容区常用段）
  const cjkMatches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff]/g) ?? [];
  // 去掉 CJK 后按西文词计
  const withoutCjk = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff]/g, ' ');
  const latinWords = withoutCjk.split(/\s+/).filter((w) => w.length > 0).length;
  const chars = text.length;
  const charsNoSpace = text.replace(/\s/g, '').length;
  return { words: cjkMatches.length + latinWords, charsNoSpace, chars };
}
