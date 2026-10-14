/**
 * LoadingOverlay —— 大文件打开时的进度遮罩，避免解析期间 UI 冻结/白屏造成「卡死」错觉。
 * 父容器需为 relative 定位。
 */
export function LoadingOverlay({ text }: { text: string }) {
  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/30 backdrop-blur-[1px]">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      <span className="text-sm font-medium text-white drop-shadow">{text}</span>
    </div>
  );
}
