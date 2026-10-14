/**
 * @jareking/writer —— Writer 文档内容模型包入口。
 *
 * 本包是「OOXML WordprocessingML 文档模型」的接口契约（T1.1），框架无关：
 * 只导出纯 TypeScript 类型与常量，不依赖任何运行时库。后续实现任务各自消费：
 *   - T1.2 解析器：docx → JkDocument
 *   - T1.3 渲染器：JkDocument → 分页布局 / DOM
 *   - T1.4 编辑器：基于 TipTap 定制 schema 映射 JkDocument
 *   - T1.5 导出器：JkDocument → docx（OOXML 序列化）
 */

export * from './model/index.js';
export * from './parser/docxParser.js';
export * from './formatProfile.js';
export * from './omml.js';
export * from './exporter/index.js';
