import type { ComponentType } from 'react'

/**
 * 办公模块接口定义
 * 所有模块（表格/文字/演示/PDF）都实现此接口，通过注册表统一挂载
 */
export interface OfficeModule {
  /** 模块唯一标识 */
  id: ModuleId
  /** 模块显示名称 */
  name: string
  /** 模块图标 */
  icon: string
  /** 模块主题色 */
  color: string
  /** 创建模块视图组件 */
  createView: () => ComponentType
  /** Ribbon 配置（选项卡、分组、按钮） */
  ribbonConfig: RibbonConfig
}

export type ModuleId = 'spreadsheet' | 'writer' | 'presentation' | 'pdf'

/** Ribbon 配置：选项卡 -> 分组 -> 按钮 */
export interface RibbonConfig {
  tabs: RibbonTab[]
}

export interface RibbonTab {
  id: string
  label: string
  groups: RibbonGroup[]
}

export interface RibbonGroup {
  id: string
  label: string
  buttons: RibbonButton[]
}

export interface RibbonButton {
  id: string
  label: string
  icon?: string
  onClick?: () => void
}
