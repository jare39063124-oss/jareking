import { describe, it, expect, beforeEach } from 'vitest'
import { moduleRegistry } from '@/modules/registry'
import { registerAllModules } from '@/modules'
import type { ModuleId } from '@/modules/types'

describe('脚手架冒烟测试', () => {
  it('vitest 可正常运行', () => {
    expect(1 + 1).toBe(2)
  })

  it('路径别名 @ 可用', async () => {
    const mod = await import('@/App')
    expect(mod.default).toBeDefined()
  })
})

describe('模块化架构', () => {
  beforeEach(() => {
    registerAllModules()
  })

  it('注册表可注册并获取 4 个模块', () => {
    const all = moduleRegistry.getAll()
    expect(all).toHaveLength(4)
  })

  it('四大模块均已注册', () => {
    const ids: ModuleId[] = ['spreadsheet', 'writer', 'presentation', 'pdf']
    ids.forEach((id) => {
      expect(moduleRegistry.has(id)).toBe(true)
    })
  })

  it('每个模块可创建视图组件', () => {
    const all = moduleRegistry.getAll()
    all.forEach((m) => {
      const View = m.createView()
      expect(View).toBeDefined()
      expect(['object', 'function']).toContain(typeof View)
    })
  })

  it('每个模块都有 ribbon 配置', () => {
    const all = moduleRegistry.getAll()
    all.forEach((m) => {
      expect(m.ribbonConfig.tabs.length).toBeGreaterThan(0)
    })
  })
})
