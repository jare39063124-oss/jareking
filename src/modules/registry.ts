import type { OfficeModule, ModuleId } from './types'

/**
 * 模块注册表
 * 四大模块在此统一注册，应用启动时初始化
 */
class ModuleRegistry {
  private modules = new Map<ModuleId, OfficeModule>()

  register(module: OfficeModule): void {
    this.modules.set(module.id, module)
  }

  get(id: ModuleId): OfficeModule | undefined {
    return this.modules.get(id)
  }

  getAll(): OfficeModule[] {
    return Array.from(this.modules.values())
  }

  has(id: ModuleId): boolean {
    return this.modules.has(id)
  }
}

export const moduleRegistry = new ModuleRegistry()
