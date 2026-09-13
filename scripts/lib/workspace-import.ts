/**
 * 工作区导入共享骨架 —— xlsx → workspaces/<name> 规范化 JSON
 *
 * 供 import-rogue-fighter.ts（含特殊处理逻辑）与 import-workspace.ts（通用
 * spec 型入口）复用。新项目接入 SOP 见 docs/runbooks/workspace-import.md。
 */

import * as XLSX from "xlsx";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { parseSheetMatrix } from "../../lib/table/parse";
import { detectColumnPattern, type ColumnPattern } from "../../lib/table/pattern";

export interface SheetSpec {
  /** xlsx 内的 sheet 名 */
  sheet: string;
  /** 输出模块目录（tables/<module>/） */
  module: string;
  /** 输出文件名（不含 .json） */
  file: string;
  /** 表头占几行（双行表头会合并为「父.子」复合键） */
  headerRows: 1 | 2;
}

export interface TableIndexEntry {
  table: string;
  module: string;
  sourceSheet: string;
  rows: number;
  columns: string[];
  /** 数值列的生成模式（等差/等比/常数）——apply_curve 与审计的依据 */
  columnPatterns?: Record<string, ColumnPattern>;
}

/** 对每列跑模式检测，仅保留有规律的数值列（常数列无信息量不标注） */
export function detectPatterns(rows: Record<string, unknown>[]): Record<string, ColumnPattern> {
  const patterns: Record<string, ColumnPattern> = {};
  const columns = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) columns.add(k);
  for (const col of columns) {
    const values = rows.map((r) => r[col]);
    const p = detectColumnPattern(values);
    if (p && p.type !== "constant") patterns[col] = p;
  }
  return patterns;
}

export function sheetToMatrix(wb: XLSX.WorkBook, name: string): unknown[][] {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`sheet 不存在: ${name}`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][];
}

export function writeTable(outRoot: string, module: string, file: string, data: unknown[]): string {
  const dir = join(outRoot, "tables", module);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${file}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  return `${module}/${file}`;
}

export interface ParsedSheet {
  spec: SheetSpec;
  rows: Record<string, unknown>[];
  columns: string[];
  indexEntry: TableIndexEntry;
}

/** 按 spec 解析一个 sheet 并落盘，返回索引条目（不写 index，由调用方汇总） */
export function importSheet(outRoot: string, wb: XLSX.WorkBook, spec: SheetSpec): ParsedSheet {
  const matrix = sheetToMatrix(wb, spec.sheet);
  const parsed = parseSheetMatrix(matrix, spec.headerRows);
  const rows = parsed.rows as Record<string, unknown>[];
  writeTable(outRoot, spec.module, spec.file, parsed.rows);
  return {
    spec,
    rows,
    columns: parsed.columns,
    indexEntry: {
      table: `${spec.module}/${spec.file}`,
      module: spec.module,
      sourceSheet: spec.sheet,
      rows: parsed.rows.length,
      columns: parsed.columns,
      columnPatterns: detectPatterns(rows),
    },
  };
}

export interface WorkspaceMeta {
  project: string;
  name: string;
  /** 数据源描述——只写中性文件名说明，不写本机路径（数据源不出仓库） */
  sources: string[];
  tables: TableIndexEntry[];
}

export function writeWorkspaceJson(outRoot: string, meta: WorkspaceMeta): void {
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(
    join(outRoot, "workspace.json"),
    JSON.stringify({ ...meta, importedAt: new Date().toISOString() }, null, 2),
    "utf-8"
  );
}
