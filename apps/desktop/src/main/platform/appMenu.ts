/**
 * 应用菜单（**macOS 必需**，Windows 保持原样不安装）。
 *
 * 为什么 macOS 必须显式安装菜单（不是可选项）：
 *  macOS 是「全局菜单栏」模型，**⌘C / ⌘V / ⌘A / ⌘Z / ⌘Q 的 accelerator 由菜单项 role 承载**。
 *  一旦 `Menu.setApplicationMenu(null)` 或菜单里缺 Edit 组，全应用复制粘贴会直接失效。
 *  显式安装标准 role 菜单同时避免依赖 Electron 默认菜单的版本差异行为。
 *
 * 与 Windows 的差异：
 *  - Windows 侧继续 `autoHideMenuBar: true` + 不装自定义菜单（Ribbon 承载全部功能入口）；
 *  - macOS 侧菜单只放**系统级 role**（appMenu / Edit / View / Window），业务入口仍在 Ribbon，
 *    这样不会与渲染层自注册的快捷键（⌘F / ⌘H / ⌘1 / ⌘F1 / ⌘⇧P）产生 accelerator 冲突。
 *
 * TODO（Phase 8 发布项）：macOS「文件」菜单（新建/打开/保存/导出 PDF）需要
 * 主进程 → 渲染层的命令通道（webContents.send），当前架构只有 invoke（渲染层发起），
 * 故留待引入命令总线后补齐，此处不写空壳菜单项（避免点了没反应）。
 */
import { Menu, app, type MenuItemConstructorOptions } from 'electron';

/**
 * 安装 macOS 应用菜单。
 *
 * @param allowDevTools 是否暴露「重新加载 / 开发者工具」（打包产物中传 false）
 */
export function installApplicationMenu(allowDevTools: boolean): void {
  const appName = app.getName();

  const appMenu: MenuItemConstructorOptions = {
    label: appName,
    submenu: [
      { role: 'about', label: `关于 ${appName}` },
      { type: 'separator' },
      { role: 'services', label: '服务' },
      { type: 'separator' },
      { role: 'hide', label: `隐藏 ${appName}` },
      { role: 'hideOthers', label: '隐藏其他' },
      { role: 'unhide', label: '全部显示' },
      { type: 'separator' },
      // ⌘Q 退出：macOS 用户肌肉记忆，必须存在
      { role: 'quit', label: `退出 ${appName}` },
    ],
  };

  // ⌘C / ⌘V / ⌘X / ⌘Z / ⌘A 全依赖这一组 role（缺失即为 P0 可用性缺陷）
  const editMenu: MenuItemConstructorOptions = {
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '拷贝' },
      { role: 'paste', label: '粘贴' },
      { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
      { role: 'delete', label: '删除' },
      { role: 'selectAll', label: '全选' },
    ],
  };

  const devItems: MenuItemConstructorOptions[] = allowDevTools
    ? [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
      ]
    : [];

  const viewMenu: MenuItemConstructorOptions = {
    label: '视图',
    submenu: [
      ...devItems,
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '进入全屏幕' },
    ],
  };

  // role: 'windowMenu' 会自动生成「最小化 / 缩放 / 前置全部窗口」，不要再手写 submenu
  const windowMenu: MenuItemConstructorOptions = { label: '窗口', role: 'windowMenu' };

  Menu.setApplicationMenu(Menu.buildFromTemplate([appMenu, editMenu, viewMenu, windowMenu]));
}
