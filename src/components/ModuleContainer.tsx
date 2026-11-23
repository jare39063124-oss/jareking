import { moduleRegistry } from '@/modules/registry'
import type { ModuleId } from '@/modules/types'

interface ModuleContainerProps {
  moduleId: ModuleId
}

/**
 * 模块视图容器
 * 根据模块 ID 从注册表获取模块并渲染其视图
 */
export function ModuleContainer({ moduleId }: ModuleContainerProps) {
  const module = moduleRegistry.get(moduleId)

  if (!module) {
    return <div style={{ padding: 20, color: '#ef4444' }}>未知模块: {moduleId}</div>
  }

  const ViewComponent = module.createView()
  return <ViewComponent />
}
