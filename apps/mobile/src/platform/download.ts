/**
 * 保存 / 导出链路（Android）。
 *
 * 问题：渲染层的所有「保存 / 导出」都走 `lib/download.ts` → `<a download>` + blob URL。
 * 桌面 Electron 由 Chromium 直接落盘；**Android WebView 没有 DownloadListener 就什么也不会发生**
 * （用户点保存 → 毫无反应，这是最伤体验的一类 bug）。
 *
 * 方案（零侵入 desktop 代码）：在 document 捕获阶段拦截 `a[download]` 的点击，
 * 改走 Capacitor Filesystem 写入应用缓存目录，再拉起系统分享面板
 * （Share）让用户存到「文件」/ 相册 / 发送到其他应用——这也是 Android 的标准导出交互。
 *
 * 非原生环境（浏览器调试）不拦截，保持原生下载行为，便于本地验证。
 */
import { isNative } from './index';

let installed = false;

/** blob → base64（Capacitor Filesystem 只接受 string/base64） */
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  // 分块转 base64，避免大文件触发 String.fromCharCode 参数过多
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 拦截一次导出：写缓存 → 系统分享 */
async function saveViaShare(url: string, filename: string): Promise<void> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');

  const blob = await (await fetch(url)).blob();
  const data = await blobToBase64(blob);
  const safeName = filename.replace(/[\\/:*?"<>|]/g, '_') || 'jareking-export';

  // Cache 目录无需任何存储权限（Android 10+ scoped storage 下最稳妥）
  const res = await Filesystem.writeFile({
    path: safeName,
    data,
    directory: Directory.Cache,
    recursive: true,
  });

  const canShare = await Share.canShare().catch(() => ({ value: false }));
  if (canShare?.value) {
    await Share.share({
      title: safeName,
      url: res.uri,
      dialogTitle: `保存或分享 ${safeName}`,
    });
  }
}

/**
 * 注册下载拦截（幂等）。
 * 只处理 blob: / data: 这类本地生成的产物（docx/xlsx/pptx/pdf/png），
 * http(s) 外链下载不拦截（交由 WebView 默认行为）。
 */
export function installDownloadInterceptor(): void {
  if (installed || !isNative()) return;
  installed = true;

  document.addEventListener(
    'click',
    (ev) => {
      const target = ev.target as Element | null;
      const anchor = target?.closest?.('a[download]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href') ?? '';
      if (!href.startsWith('blob:') && !href.startsWith('data:')) return;

      // 阻止 WebView 的默认下载（Android 上本来就不会生效，这里保证不会出现半截状态）
      ev.preventDefault();
      ev.stopPropagation();

      const name = anchor.getAttribute('download') || 'jareking-export';
      void saveViaShare(href, name).catch(async (err) => {
        console.error('[jareking-mobile] 导出失败：', err);
        // 动态导入：避免平台层与渲染层 store 形成静态循环依赖
        try {
          const { toast } = await import('@renderer/stores/toastStore');
          toast.warning(`导出失败：${err?.message ?? err}`);
        } catch {
          /* toast 不可用时静默（后台能力不得打断用户） */
        }
      });
    },
    true,
  );
}
