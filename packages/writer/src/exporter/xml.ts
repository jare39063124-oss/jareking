/**
 * XML 辅助工具（T1.5 导出器）。
 *
 * 提供：文本/属性转义、以及把解析器保留的「NS 去除后」原始节点树
 * （`data.__raw` / `JkDocument.data.__unparsedBlocks[].raw`）重新序列化回带
 * 命名空间的 XML，用于「未知内容先保留再降级」的 L2 兜底（避免 round-trip 丢数据）。
 */

/** 转义 XML 文本节点（& < >） */
export function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 转义 XML 属性值（文本转义 + 引号） */
export function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * 关系型属性（id/embed/link）在 OOXML 中属于 r: 命名空间；其余默认归到 w:。
 * 解析器去除前缀后无法还原，这里按约定重建，保证超链接/图片引用的 r:id 正确。
 */
function attrPrefix(name: string): string {
  if (name === 'id' || name === 'embed' || name === 'link') return `r:${name}`;
  return `w:${name}`;
}

/**
 * 把「NS 去除后」的原始节点对象拆成 { attrs, inner } 两部分：
 * - attrs：元素自身的属性字符串（带命名空间前缀）
 * - inner：子元素 + 文本的连接串（元素默认带 w: 前缀）
 *
 * 调用方负责写出外层标签：`<w:tag${attrs}>${inner}</w:tag>`。
 * 由于本包解析器使用 removeNSPrefix，重新解析时只关心本地名，因此前缀选择
 * 以「可被重新解析 + 关系属性归 r:」为准则，足够支撑 L2 兜底的 round-trip。
 */
export function rawNodeToParts(
  node: any,
  defaultNs = 'w',
): { attrs: string; inner: string } {
  let attrs = '';
  let inner = '';
  if (node === null || node === undefined) return { attrs, inner };
  if (typeof node === 'string') {
    inner = escapeXmlText(node);
    return { attrs, inner };
  }
  if (Array.isArray(node)) {
    inner = node.map((n) => rawNodeToParts(n, defaultNs).inner).join('');
    return { attrs, inner };
  }
  for (const key of Object.keys(node)) {
    if (key.startsWith('@_')) {
      const name = key.slice(2);
      attrs += ` ${attrPrefix(name)}="${escapeXmlAttr(String(node[key]))}"`;
    } else if (key === '#text') {
      inner += escapeXmlText(String(node[key]));
    } else if (key.startsWith('#') || key.startsWith('?')) {
      // 注释 / 处理指令等：忽略
    } else {
      const child = node[key];
      const { attrs: ca, inner: ci } = rawNodeToParts(child, defaultNs);
      inner += `<${defaultNs}:${key}${ca}>${ci}</${defaultNs}:${key}>`;
    }
  }
  return { attrs, inner };
}
