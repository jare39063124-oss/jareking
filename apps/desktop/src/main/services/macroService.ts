/**
 * 宏服务（主进程）：用户 JavaScript 宏的 CRUD 存储。
 *
 * 存储位置：`<userData>/macros/<name>.js`（纯文本，UTF-8）。
 *
 * 安全边界：
 *  - 文件名经 `sanitizeMacroName` 安全化，拒绝路径穿越（`../`）与非法字符；
 *  - 目录穿越做二次防护：最终路径 normalize 后必须仍落在 macros 目录内；
 *  - 删除仅作用于 macros 目录内、以 `.js` 结尾的直接子文件。
 *
 * ⚠️ 主进程只负责「存取」，**绝不执行宏代码**（执行在渲染进程 Web Worker 沙箱，
 *    见 `renderer/src/lib/macroRunner.ts` 与 `macroWorker.ts`）。
 */
import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { getUserDataDir } from './db.js';
import { sanitizeMacroName, MACRO_FILE_EXT, type MacroMeta } from '../../shared/macroUtils.js';

// 契约类型单一来源：MacroMeta 定义于 shared/macroUtils.ts，此处转发供主进程侧引用
export type { MacroMeta };

/** 解析结果：宏目录内某个宏的完整路径 */
interface ResolvedMacro {
  dir: string;
  full: string;
  canonicalName: string;
}

export class MacroService {
  /** 宏目录绝对路径（不创建） */
  private baseDir(): string {
    return join(getUserDataDir(), 'macros');
  }

  /** 宏目录绝对路径（惰性创建） */
  private async ensureDir(): Promise<string> {
    const dir = this.baseDir();
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * 把宏名解析为宏目录内的文件路径。
   * @param name 宏名（未经信任）
   * @param create 是否创建目录
   * @throws 宏名非法 / 路径逃逸时抛出（中文原因）
   */
  private async resolve(name: string, create: boolean): Promise<ResolvedMacro> {
    const sanitized = sanitizeMacroName(name);
    if (!sanitized.ok) throw new Error(sanitized.reason ?? '非法宏名');
    const dir = create ? await this.ensureDir() : this.baseDir();
    const full = join(dir, `${sanitized.name}${MACRO_FILE_EXT}`);
    // 二次防护：normalize 后的最终路径必须仍在宏目录内
    const normDir = normalize(dir) + sep;
    if (!normalize(full).startsWith(normDir)) throw new Error('非法的宏文件路径');
    return { dir, full, canonicalName: sanitized.name };
  }

  /** 列出全部宏（名称 + 最后修改时间），按更新时间倒序 */
  async list(): Promise<MacroMeta[]> {
    const dir = this.baseDir();
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const metas: MacroMeta[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(MACRO_FILE_EXT)) continue;
      const name = entry.name.slice(0, -MACRO_FILE_EXT.length);
      const info = await stat(join(dir, entry.name)).catch(() => null);
      metas.push({ name, updatedAt: info?.mtimeMs ?? 0 });
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt);
    return metas;
  }

  /** 读取宏代码；不存在返回空串 */
  async read(name: string): Promise<string> {
    const { full } = await this.resolve(name, false);
    const exists = await stat(full).then(() => true).catch(() => false);
    if (!exists) return '';
    return readFile(full, 'utf8');
  }

  /** 新建 / 覆盖保存宏；返回元信息 */
  async save(name: string, code: string): Promise<MacroMeta> {
    const { full, canonicalName } = await this.resolve(name, true);
    await writeFile(full, typeof code === 'string' ? code : '', 'utf8');
    const info = await stat(full).catch(() => null);
    return { name: canonicalName, updatedAt: info?.mtimeMs ?? Date.now() };
  }

  /** 删除宏；返回是否确有删除 */
  async remove(name: string): Promise<boolean> {
    const { full } = await this.resolve(name, false);
    const exists = await stat(full).then(() => true).catch(() => false);
    if (!exists) return false;
    await rm(full, { force: true });
    return true;
  }
}
