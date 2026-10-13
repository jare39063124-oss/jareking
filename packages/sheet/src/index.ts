/**
 * @jareking/sheet —— jareking Sheet 表格数据层入口。
 *
 * T2.1 契约：xlsx ↔ JkWorkbook（exceljs 实现，浏览器/Node 双环境）。
 * T2.2 表格引擎（Univer）与 T2.3 公式引擎经此包与文件层交互。
 */

export * from './model/index.js';
export * from './parser/xlsxParser.js';
export * from './exporter/index.js';
export * from './exporter/csv.js';
