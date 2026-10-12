/**
 * SQLite 封装：基于 sql.js（WASM 版 SQLite，无需原生编译）。
 * 职责：数据库文件打开/落盘（防抖 500ms）、SQL 执行、事务与迁移调度。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { MIGRATIONS } from './migrations.js';

/** sql.js 初始化后的模块对象 */
type SqlJsModule = Awaited<ReturnType<typeof initSqlJs>>;
/** sql.js 数据库实例句柄 */
type SqlDatabase = InstanceType<SqlJsModule['Database']>;

/** SQL 绑定参数取值类型（与 sql.js 对齐） */
export type SqlValue = number | string | Uint8Array | null;

/** SQL 查询结果（sql.js 原始结构：列名 + 二维值数组） */
export interface QueryResult {
  columns: string[];
  values: SqlValue[][];
}

/** 一行查询结果（列名 → 值） */
export type Row = Record<string, SqlValue>;

/** 迁移定义：按 version 升序执行；新增迁移只需在 MIGRATIONS 末尾追加 */
export interface Migration {
  version: number;
  name: string;
  /** 执行 DDL / 数据变更（在事务内执行） */
  up: (db: { exec: (sql: string, params?: SqlValue[]) => void }) => void;
}

/** 数据库文件名（位于 userDataDir 下） */
const DB_FILE_NAME = 'jareking.db';

/** 落盘防抖间隔（ms） */
const SAVE_DEBOUNCE_MS = 500;

export class Database {
  private readonly handle: SqlDatabase;
  private readonly dbPath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** 事务嵌套深度：> 0 表示已开启事务 */
  private txDepth = 0;
  private closed = false;

  private constructor(handle: SqlDatabase, dbPath: string) {
    this.handle = handle;
    this.dbPath = dbPath;
  }

  /**
   * 打开数据库：文件存在则加载，不存在则新建空库；随后自动执行迁移。
   * @param dbPath 数据库文件完整路径
   */
  static async open(dbPath: string): Promise<Database> {
    const SQL = await initSqlJs();
    let data: Uint8Array | undefined;
    if (existsSync(dbPath)) {
      data = new Uint8Array(readFileSync(dbPath));
    }
    const handle = data ? new SQL.Database(data) : new SQL.Database();
    const db = new Database(handle, dbPath);
    db.migrate();
    return db;
  }

  /**
   * 便捷入口：在 userDataDir 下打开（或新建）jareking.db 并完成迁移。
   */
  static async create(userDataDir: string): Promise<Database> {
    return Database.open(join(userDataDir, DB_FILE_NAME));
  }

  /** 执行 SQL。无 params 时支持多条语句（分号分隔，用于 DDL）；有 params 时须为单语句 */
  exec(sql: string, params?: SqlValue[]): QueryResult[] {
    this.assertOpen();
    return this.handle.exec(sql, params ?? undefined);
  }

  /** 查询并映射为行对象数组（取 SQL 中第一条语句的结果） */
  all<T = Row>(sql: string, params?: SqlValue[]): T[] {
    const results = this.exec(sql, params);
    const first = results[0];
    if (!first) return [];
    const { columns, values } = first;
    return values.map((row) => {
      const obj: Row = {};
      columns.forEach((col, i) => {
        obj[col] = row[i] ?? null;
      });
      return obj as T;
    });
  }

  /**
   * 事务：最外层开启 SAVEPOINT，嵌套事务逐层保存点；
   * 任一层出错时回滚到对应保存点并向上抛出，保证原子性。
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen();
    this.txDepth += 1;
    const savepoint = `jk_sp_${this.txDepth}`;
    this.handle.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      this.handle.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.handle.exec(`ROLLBACK TO ${savepoint}`);
      this.handle.exec(`RELEASE ${savepoint}`);
      throw error;
    } finally {
      this.txDepth -= 1;
    }
  }

  /** 标记数据已变更：500ms 防抖后写回数据库文件（多次写入只落盘一次） */
  save(): void {
    if (this.closed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
    // 防止定时器阻止进程退出（Electron 主进程 / 测试场景）
    this.saveTimer.unref?.();
  }

  /** 立即落盘（取消尚未执行的防抖写入） */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.closed) return;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    writeFileSync(this.dbPath, this.handle.export());
  }

  /** 刷新待写数据并关闭数据库（关闭后不可再用） */
  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    this.handle.close();
  }

  /**
   * 执行迁移：确保 migrations 表存在，按 version 升序应用未执行过的迁移。
   * 重复调用是幂等的（已应用的版本跳过），返回当前数据库版本。
   */
  migrate(): number {
    this.assertOpen();
    this.handle.exec(
      `CREATE TABLE IF NOT EXISTS migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at INTEGER NOT NULL
       )`,
    );
    const applied = new Set(
      this.all<Row>('SELECT version FROM migrations').map((row) => Number(row['version'])),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        migration.up(this);
        this.exec('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)', [
          migration.version,
          migration.name,
          Date.now(),
        ]);
      });
    }
    return this.currentVersion();
  }

  /** 当前数据库版本（无迁移记录时为 0） */
  currentVersion(): number {
    const rows = this.all<Row>('SELECT MAX(version) AS v FROM migrations');
    const value = rows[0]?.['v'];
    return value === null || value === undefined ? 0 : Number(value);
  }

  /** 读取键值设置；不存在返回 null */
  getSetting(key: string): string | null {
    const rows = this.all<Row>('SELECT value FROM settings WHERE key = ?', [key]);
    return rows[0] ? String(rows[0]['value']) : null;
  }

  /** 写入键值设置（不存在则插入，存在则覆盖），并在事务内落盘 */
  setSetting(key: string, value: string): void {
    this.transaction(() => {
      this.exec(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value],
      );
    });
    this.save();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('数据库已关闭，不能继续操作');
    }
  }
}

/**
 * 在 userDataDir 下创建（或打开）本地数据库并完成迁移。
 * v1 零服务端依赖：单文件 SQLite，全部数据保存在用户目录。
 */
export async function createDatabase(userDataDir: string): Promise<Database> {
  return Database.create(userDataDir);
}
