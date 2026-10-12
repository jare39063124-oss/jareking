import { create } from 'zustand';

/** Toast 类型 */
export type ToastType = 'success' | 'info' | 'warning';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
}

interface ToastState {
  toasts: ToastItem[];
  pushToast: (type: ToastType, message: string) => void;
  dismissToast: (id: string) => void;
}

/** 同屏最多保留的 Toast 数量，超出时丢弃最早的 */
const MAX_VISIBLE_TOASTS = 4;

let toastSeq = 0;

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],

  pushToast: (type, message) =>
    set((state) => {
      const item: ToastItem = { id: `toast-${++toastSeq}`, type, message };
      return { toasts: [...state.toasts, item].slice(-MAX_VISIBLE_TOASTS) };
    }),

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/** 便捷调用：toast.success('已保存') / toast.info('功能建设中') */
export const toast = {
  success: (message: string) => useToastStore.getState().pushToast('success', message),
  info: (message: string) => useToastStore.getState().pushToast('info', message),
  warning: (message: string) => useToastStore.getState().pushToast('warning', message),
};

/** 占位功能的统一提示（Ribbon 等占位按钮点击时调用） */
export const toastNotImplemented = (feature = '该功能') =>
  toast.info(`${feature}功能建设中`);
