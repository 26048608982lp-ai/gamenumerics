/**
 * 环境类工具 — 工作区表清单与读表（查表场景的核心工具）
 *
 * 数据来自导入脚本产出的规范化工作区（workspace.json 索引 + tables/*.json）。
 * 路径沙箱：表名解析后必须落在 workspaceRoot 内，禁止 ../ 逃逸。
 */

import { readFileSync } from "fs";
import { join } from "path";
import { loadTableRows, tablePath } from "../../storage";
import type { ToolDefinition } from "../protocol";

interface WorkspaceIndex {
  project: string;
  name: string;
  tables: { table: string; module: string; sourceSheet: string; rows: number; columns: string[] }[];
}

type FilterOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains";
interface FilterCondition {
  column: string;
  op: FilterOp;
  value: string | number;
}

function applyFilter(rows: Record<string, unknown>[], filters?: FilterCondition[]) {
  if (!filters?.length) return rows;
  return rows.filter((row) =>
    filters.every((f) => {
      const v = row[f.column];
      if (f.op === "contains") return String(v ?? "").includes(String(f.value));
      if (v === undefined || typeof v !== "number" || typeof f.value !== "number") {
        // 非数值比较一律按字符串等值/不等处理
        const sv = String(v ?? "");
        const tv = String(f.value);
        return f.op === "eq" ? sv === tv : f.op === "ne" ? sv !== tv : false;
      }
      switch (f.op) {
        case "eq": return v === f.value;
        case "ne": return v !== f.value;
        case "gt": return v > f.value;
        case "gte": return v >= f.value;
        case "lt": return v < f.value;
        case "lte": return v <= f.value;
        default: return false;
      }
    })
  );
}

export const workspaceToolDefinitions: ToolDefinition[] = [
  {
    name: "list_tables",
    description:
      "列出当前工作区的全部数值表清单：表名、所属模块、行数、列名。回答数值问题前先用它定位要查哪张表、有哪些列可用。",
    parameters: {
      type: "object",
      properties: {
        module: { type: "string", description: "按模块过滤（可选）：settings/growth/equipment/level/hero/economy/rogue/talent/enemy/gamedata" },
      },
    },
    access: "read",
    module: "workspace",
    execute: async (params, ctx) => {
      const { module } = (params ?? {}) as { module?: string };
      let index: WorkspaceIndex;
      try {
        index = JSON.parse(readFileSync(join(ctx.workspaceRoot, "workspace.json"), "utf-8")) as WorkspaceIndex;
      } catch {
        return { success: false, error: "工作区索引不存在，请先运行导入脚本" };
      }
      const tables = module ? index.tables.filter((t) => t.module === module) : index.tables;
      return {
        success: true,
        data: { project: index.name, tableCount: tables.length, tables },
      };
    },
  },
  {
    name: "read_table",
    description:
      "读取工作区内指定数值表的数据行。支持列选择、条件过滤（eq/ne/gt/gte/lt/lte/contains）、分页（offset/limit，默认前 20 行）。先用 list_tables 拿到表名和列名。",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "表名，如 hero/成长表（来自 list_tables 的 table 字段）" },
        columns: { type: "array", items: { type: "string" }, description: "只返回指定列（可选）" },
        filter: {
          type: "array",
          description: "过滤条件，多条件 AND（可选）",
          items: {
            type: "object",
            properties: {
              column: { type: "string" },
              op: { type: "string", enum: ["eq", "ne", "gt", "gte", "lt", "lte", "contains"] },
              value: { type: ["string", "number"] },
            },
            required: ["column", "op", "value"],
          },
        },
        offset: { type: "number", description: "跳过前 N 行（默认 0）" },
        limit: { type: "number", description: "返回行数上限（默认 20，全表导出可设大）" },
      },
      required: ["table"],
    },
    access: "read",
    module: "workspace",
    execute: async (params, ctx) => {
      const p = (params ?? {}) as {
        table: string;
        columns?: string[];
        filter?: FilterCondition[];
        offset?: number;
        limit?: number;
      };
      if (!p.table || typeof p.table !== "string") {
        return { success: false, error: "缺少 table 参数" };
      }
      if (!tablePath(ctx.workspaceRoot, p.table)) {
        return { success: false, error: `非法表名（路径逃逸）: ${p.table}` };
      }
      const rows = loadTableRows(ctx.workspaceRoot, p.table);
      if (!rows) return { success: false, error: `表不存在: ${p.table}，请用 list_tables 确认表名` };

      const filtered = applyFilter(rows, p.filter);
      const offset = Math.max(0, p.offset ?? 0);
      const limit = Math.min(Math.max(1, p.limit ?? 20), 500);
      let page = filtered.slice(offset, offset + limit);
      if (p.columns?.length) {
        page = page.map((row) => {
          const picked: Record<string, unknown> = {};
          for (const c of p.columns!) if (row[c] !== undefined) picked[c] = row[c];
          return picked;
        });
      }
      return {
        success: true,
        data: {
          table: p.table,
          totalRows: rows.length,
          matchedRows: filtered.length,
          returnedRows: page.length,
          offset,
          rows: page,
        },
      };
    },
  },
];
