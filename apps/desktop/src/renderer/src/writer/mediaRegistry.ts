/**
 * mediaRegistry —— 图片二进制 → Blob URL 注册表（#46-B 大文件内存优化）。
 *
 * 背景（问题）：
 *   jkToHtml 以往把图片二进制直接 base64 内联进 HTML 字符串，ProseMirror 又把整段
 *   HTML 驻留 DOM，导致图片在「模型 media」与「DOM base64」两份共存（双倍内存）。
 *   大文档（图片常占数十~上百 MB）首屏/编辑时内存峰值极高，逼近 OOM。
 *
 * 方案：
 *   - 模型 media（doc.media[relId]）仍是导出唯一真源，字节只存一份。
 *   - 显示侧改用 Blob URL（一个短字符串句柄），DOM 不再持有 base64，内存大幅下降。
 *   - relId 经 data-jk-media 属性随 DOM 保留；保存时 htmlToJk 据此从注册表取回字节，
 *     彻底规避「blob: 不可还原 → 保存后图片丢失」问题。
 *
 * 生命周期：文档加载时登记字节 + 创建 Blob URL；卸载/换文档时 revoke，防止 URL 泄漏。
 *
 * 仅渲染进程可用（依赖浏览器 URL.createObjectURL）。
 */

export interface MediaEntry {
  relId: string;
  bytes: Uint8Array;
  mime: string;
  blobUrl?: string;
}

export class MediaRegistry {
  private map = new Map<string, MediaEntry>();

  /** 登记模型侧字节（解析 docx 后调用）。同 relId 覆盖。 */
  set(relId: string, bytes: Uint8Array, mime: string): void {
    this.map.set(relId, { relId, bytes, mime });
  }

  /**
   * 取得或创建 Blob URL（显示侧调用，幂等）。
   * 多次调用返回同一 URL；revokeAll 后再次调用会重新创建。
   */
  blobUrl(relId: string): string | undefined {
    const e = this.map.get(relId);
    if (!e) return undefined;
    if (!e.blobUrl) {
      const blob = new Blob([e.bytes], { type: e.mime || 'application/octet-stream' });
      e.blobUrl = URL.createObjectURL(blob);
    }
    return e.blobUrl;
  }

  /** 取字节（保存侧调用）。 */
  bytes(relId: string): Uint8Array | undefined {
    return this.map.get(relId)?.bytes;
  }

  /** 遍历所有条目（保存侧批量导出字节）。 */
  entries(): IterableIterator<[string, MediaEntry]> {
    return this.map.entries();
  }

  /** 释放所有 Blob URL（不清除字节登记）。 */
  revokeAll(): void {
    for (const e of this.map.values()) {
      if (e.blobUrl) {
        URL.revokeObjectURL(e.blobUrl);
        e.blobUrl = undefined;
      }
    }
  }

  /** 清空（revoke + 删除所有登记）。换文档前调用，避免旧 Blob URL 泄漏。 */
  clear(): void {
    this.revokeAll();
    this.map.clear();
  }
}
