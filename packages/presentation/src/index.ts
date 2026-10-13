/**
 * @jareking/presentation —— jareking Presentation 数据层入口。
 *
 * T3.1 契约：pptx → JkPresentation（解析先行；导出器 T3.4 交付）。
 * T3.2 幻灯片编辑器（Konva/Fabric canvas）经此包与文件层交互。
 */

export * from './model/index.js';
export * from './parser/pptxParser.js';
