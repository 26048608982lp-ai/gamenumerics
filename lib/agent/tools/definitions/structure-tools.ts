/**
 * 结构推断工具族 — L2 结构 IR 的确定性推断与固化（纯函数 + fs，无 LLM）
 *
 * grade_workspace / profile_table / infer_foreign_keys 三个 read 档工具产出
 * inferred 态卡片与候选（不落盘）；save_structure 为 write 档低风险写——只写
 * structure.json sidecar 不碰数值表，宿主 confirmWrite 与 save_memory/restore_table
 * 同列直接放行。confirmed 状态由用户会话确认后写入。
 */

import { readFileSync } from "fs";
import { join } from "path";
import { inferColumnRule } from "@/lib/table/pattern";
import { loadTableRows, tablePath } from "../../storage";
import {
  loadStructure,
  saveStructure,
  mergeStructure,
  emptyStructure,
  type WorkspaceStructure,
  type StructurePatch,
  type TableCard,
  type FieldCard,
  type RelationEdge,
  type RelationKind,
  type IntentCard,
  type StructureGrade,
} from "../../structure";
import type { ToolContext, ToolDefinition } from "../protocol";

interface WorkspaceIndexTable {
  table: string;
  module: string;
  sourceSheet?: string;
  rows?: number;
  columns: string[];
  columnPatterns?: Record<string, unknown>;
}
interface WorkspaceIndex {
  project: string;
  name: string;
  tables: WorkspaceIndexTable[];
}

function readIndex(ctx: ToolContext): WorkspaceIndex | null {
  try {
    return JSON.parse(readFileSync(join(ctx.workspaceRoot, "workspace.json"), "utf-8")) as WorkspaceIndex;
  } catch {
    return null;
  }
}

const r4 = (v: number) => Number(v.toFixed(4));
const CJK_RE = /[\u4e00-\u9fff]/;

/* ── 判级阈值（命名常量，输入契约三级分档的立论线）── */
/** 表级 A 线：双行表头点分列名占比 ≥ 0.3 即视为 A 规范信号 */
const GRADE_DOTTED_MIN = 0.3;
/** 表级 A 线：列生成模式命中率 ≥ 0.5 同样立 A（单行表头但规则可全量重算） */
const GRADE_PATTERN_MIN = 0.5;
/** C 裸表线：中文语义表头占比 < 0.5 判 C（程序侧导出，机器难自证语义） */
const GRADE_CJK_MIN = 0.5;
/** 工作区判 A 线：A 级表占比 ≥ 0.6 */
const GRADE_WS_A_MIN = 0.6;
/** 工作区判 C 线：C 级表占比 ≥ 0.5 */
const GRADE_WS_C_MIN = 0.5;

/** 可连接列（外键候选/主数据角色候选）：索引/序号/index/以 id 结尾 */
function isJoinColumn(col: string): boolean {
  return /索引|序号/.test(col) || /index/i.test(col) || /id$/i.test(col);
}

/** 等级类列（成长表角色候选的锚）：等级/档位/天数/关卡/level */
function isLevelColumn(col: string): boolean {
  return /等级|档位|天数|关卡/.test(col) || /level/i.test(col);
}

/* ─────────────────────── grade_workspace ─────────────────────── */

function gradeOneTable(t: WorkspaceIndexTable) {
  const cols = t.columns ?? [];
  const dotted = cols.filter((c) => c.includes(".")).length;
  const patternCols = Object.keys(t.columnPatterns ?? {}).length;
  const cjkCols = cols.filter((c) => CJK_RE.test(c)).length;
  const dottedRatio = cols.length > 0 ? dotted / cols.length : 0;
  const patternHitRate = cols.length > 0 ? patternCols / cols.length : 0;
  const cjkRatio = cols.length > 0 ? cjkCols / cols.length : 0;

  // A 规范：双行表头点分列名或列模式命中率达标；C 裸表：无中文语义表头（程序侧导出）；其余 B 半规范
  const level: "A" | "B" | "C" =
    dottedRatio >= GRADE_DOTTED_MIN || patternHitRate >= GRADE_PATTERN_MIN ? "A" : cjkRatio < GRADE_CJK_MIN ? "C" : "B";
  // 孤儿初判（粗筛）：无外键候选列 且 无角色候选信号（列模式/点分表头）
  const orphan = !cols.some(isJoinColumn) && patternCols === 0 && dotted === 0;
  return { table: t.table, module: t.module, level, dottedColumnRatio: r4(dottedRatio), patternHitRate: r4(patternHitRate), orphan };
}

/* ─────────────────────── profile_table ─────────────────────── */

interface ColumnProfile {
  column: string;
  type: string;
  distinct: number;
  enumRatio: number;
  monotonic: "递增" | "递减" | "无";
  unique: boolean;
}

function profileOneColumn(rows: Record<string, unknown>[], col: string): ColumnProfile {
  const values = rows.map((r) => r[col]);
  const nonNull = values.filter((v) => v !== undefined && v !== null && v !== "");
  const distinct = new Set(nonNull).size;
  const types = new Set(nonNull.map((v) => typeof v));
  const type = types.size <= 1 ? (nonNull.length === 0 ? "empty" : [...types][0]) : "mixed";

  let monotonic: ColumnProfile["monotonic"] = "无";
  if (nonNull.length === rows.length && nonNull.length >= 2 && types.size === 1 && types.has("number")) {
    const nums = nonNull as number[];
    const nonDecreasing = nums.every((v, i) => i === 0 || v >= nums[i - 1]);
    const nonIncreasing = nums.every((v, i) => i === 0 || v <= nums[i - 1]);
    const hasStrict = nums.some((v, i) => i > 0 && v !== nums[i - 1]);
    if (nonDecreasing && hasStrict) monotonic = "递增";
    else if (nonIncreasing && hasStrict) monotonic = "递减";
  }
  const unique = nonNull.length === rows.length && distinct === rows.length;
  return { column: col, type, distinct, enumRatio: r4(distinct / rows.length), monotonic, unique };
}

/**
 * 累计列检测：cum[i] ≈ base[0..i] 逐行前缀和。
 * thresholdPct=1（%）与 lib/table/relation.ts 的相对容差同口径（同构容差哲学：
 * Math.max(1, |prefix|×1%) 以绝对下限兜取整损失，相对容差兜浮点噪声，取大判容）。
 */
function detectCumulativeColumns(
  rows: Record<string, unknown>[],
  columns: string[],
  thresholdPct = 1
): { base: string; cumulative: string }[] {
  if (rows.length < 3) return [];
  const numericCols = columns.filter((col) => rows.every((r) => typeof r[col] === "number" && Number.isFinite(r[col])));
  const out: { base: string; cumulative: string }[] = [];
  for (const base of numericCols) {
    const baseVals = rows.map((r) => r[base] as number);
    if (baseVals.every((v) => v === 0)) continue; // 全 0 基列退化为恒等，无结构意义
    for (const cum of numericCols) {
      if (cum === base) continue;
      let prefix = 0;
      let ok = true;
      for (let i = 0; i < rows.length; i++) {
        prefix += baseVals[i];
        const actual = rows[i][cum] as number;
        if (Math.abs(actual - prefix) > Math.max(1, (Math.abs(prefix) * thresholdPct) / 100)) {
          ok = false;
          break;
        }
      }
      if (ok) out.push({ base, cumulative: cum });
    }
  }
  return out;
}

/* ─────────────────────── infer_foreign_keys ─────────────────────── */

const FK_DANGLING_MAX = 0.05;
const FK_TOP_N_DEFAULT = 20;
const FK_TOP_N_MAX = 50;
const FK_MIN_NONNULL = 3;
const FK_MAX_SCAN_TABLES = 40;

interface ColumnDomain {
  domain: Set<unknown>;
  nonNull: number;
}

function columnDomains(rows: Record<string, unknown>[]): Map<string, ColumnDomain> {
  const out = new Map<string, ColumnDomain>();
  if (rows.length === 0) return out;
  for (const col of Object.keys(rows[0])) {
    const nonNull = rows.map((r) => r[col]).filter((v) => v !== undefined && v !== null && v !== "");
    out.set(col, { domain: new Set(nonNull), nonNull: nonNull.length });
  }
  return out;
}

/* ─────────────────────── save_structure 参数规范化 ─────────────────────── */

const STRUCTURE_STATUSES: string[] = ["inferred", "confirmed", "rejected"];
const INTENT_STATUSES: string[] = ["proposed", "confirmed", "rejected"];
const RELATION_KINDS: string[] = ["foreign_key", "derived", "aggregate"];

function normalizeStatus(v: unknown, allowed: string[], fallback: string): string {
  return typeof v === "string" && allowed.includes(v) ? v : fallback;
}
/** 字符串数组规范化：非数组 → 空数组，混入的非字符串元素剔除（evidence 与 consumers 复用） */
function normalizeStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : [];
}
function normalizeConfidence(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.5;
}
function normalizeOptionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function normalizeEndpoint(v: unknown, where: string): { table: string; column: string } | { error: string } {
  if (!v || typeof v !== "object") return { error: `${where} 必须为 {table, column} 对象` };
  const { table, column } = v as Record<string, unknown>;
  if (typeof table !== "string" || !table || typeof column !== "string" || !column) {
    return { error: `${where} 的 table/column 必须为非空字符串` };
  }
  return { table, column };
}

/** LLM 传入的 structure 增量规范化：结构必填项缺失报错，可缺省项填默认值 */
function normalizeStructurePatch(raw: Record<string, unknown>): { patch?: StructurePatch; error?: string } {
  const patch: StructurePatch = {};

  if (raw.tables !== undefined) {
    if (!Array.isArray(raw.tables)) return { error: "structure.tables 必须为数组" };
    const tables: TableCard[] = [];
    for (const [i, item] of raw.tables.entries()) {
      if (!item || typeof item !== "object") return { error: `structure.tables[${i}] 必须为对象` };
      const t = item as Record<string, unknown>;
      if (typeof t.table !== "string" || !t.table) return { error: `structure.tables[${i}].table 必须为非空字符串` };
      tables.push({
        table: t.table,
        role: normalizeOptionalString(t.role),
        roleStatus: normalizeStatus(t.roleStatus, STRUCTURE_STATUSES, "inferred") as TableCard["roleStatus"],
        primaryKey: normalizeOptionalString(t.primaryKey),
        grain: normalizeOptionalString(t.grain),
        confidence: normalizeConfidence(t.confidence),
        evidence: normalizeStringArray(t.evidence),
      });
    }
    patch.tables = tables;
  }

  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields)) return { error: "structure.fields 必须为数组" };
    const fields: FieldCard[] = [];
    for (const [i, item] of raw.fields.entries()) {
      if (!item || typeof item !== "object") return { error: `structure.fields[${i}] 必须为对象` };
      const f = item as Record<string, unknown>;
      if (typeof f.table !== "string" || !f.table || typeof f.column !== "string" || !f.column) {
        return { error: `structure.fields[${i}].table/column 必须为非空字符串` };
      }
      fields.push({
        table: f.table,
        column: f.column,
        semanticType: normalizeOptionalString(f.semanticType),
        unit: normalizeOptionalString(f.unit),
        enumCardinality: typeof f.enumCardinality === "number" && Number.isFinite(f.enumCardinality) ? f.enumCardinality : undefined,
        status: normalizeStatus(f.status, STRUCTURE_STATUSES, "inferred") as FieldCard["status"],
      });
    }
    patch.fields = fields;
  }

  if (raw.relations !== undefined) {
    if (!Array.isArray(raw.relations)) return { error: "structure.relations 必须为数组" };
    const relations: RelationEdge[] = [];
    for (const [i, item] of raw.relations.entries()) {
      if (!item || typeof item !== "object") return { error: `structure.relations[${i}] 必须为对象` };
      const r = item as Record<string, unknown>;
      const from = normalizeEndpoint(r.from, `structure.relations[${i}].from`);
      if ("error" in from) return { error: from.error };
      const to = normalizeEndpoint(r.to, `structure.relations[${i}].to`);
      if ("error" in to) return { error: to.error };
      if (typeof r.kind !== "string" || !RELATION_KINDS.includes(r.kind)) {
        return { error: `structure.relations[${i}].kind 必须为 ${RELATION_KINDS.join("/")}` };
      }
      relations.push({
        from,
        to,
        kind: r.kind as RelationKind,
        confidence: normalizeConfidence(r.confidence),
        status: normalizeStatus(r.status, STRUCTURE_STATUSES, "inferred") as RelationEdge["status"],
        evidence: normalizeStringArray(r.evidence),
        danglingRate: typeof r.danglingRate === "number" && Number.isFinite(r.danglingRate) && r.danglingRate >= 0 ? r.danglingRate : undefined,
      });
    }
    patch.relations = relations;
  }

  if (raw.intents !== undefined) {
    if (!Array.isArray(raw.intents)) return { error: "structure.intents 必须为数组" };
    const intents: IntentCard[] = [];
    for (const [i, item] of raw.intents.entries()) {
      if (!item || typeof item !== "object") return { error: `structure.intents[${i}] 必须为对象` };
      const c = item as Record<string, unknown>;
      if (typeof c.id !== "string" || !c.id) return { error: `structure.intents[${i}].id 必须为非空字符串` };
      intents.push({
        id: c.id,
        statement: typeof c.statement === "string" ? c.statement : "",
        evidence: normalizeStringArray(c.evidence),
        confidence: normalizeConfidence(c.confidence),
        status: normalizeStatus(c.status, INTENT_STATUSES, "proposed") as IntentCard["status"],
        consumers: normalizeStringArray(c.consumers),
      });
    }
    patch.intents = intents;
  }

  if (raw.orphanTables !== undefined) {
    if (!Array.isArray(raw.orphanTables) || !raw.orphanTables.every((t) => typeof t === "string")) {
      return { error: "structure.orphanTables 必须为字符串数组" };
    }
    patch.orphanTables = raw.orphanTables as string[];
  }

  if (raw.grade !== undefined) {
    if (!raw.grade || typeof raw.grade !== "object") return { error: "structure.grade 必须为对象" };
    const g = raw.grade as Record<string, unknown>;
    if (g.level !== "A" && g.level !== "B" && g.level !== "C") {
      return { error: "structure.grade.level 必须为 A/B/C" };
    }
    const coverage =
      g.coverage && typeof g.coverage === "object" && !Array.isArray(g.coverage)
        ? (g.coverage as Record<string, unknown>)
        : {};
    patch.grade = { level: g.level, coverage } as StructureGrade;
  }

  if (typeof raw.gradedAt === "string") patch.gradedAt = raw.gradedAt;

  if (Object.keys(patch).length === 0) {
    return { error: "structure 至少包含一个有效 section（tables/fields/relations/orphanTables/intents/grade）" };
  }
  return { patch };
}

/* ─────────────────────── 工具注册 ─────────────────────── */

export const structureToolDefinitions: ToolDefinition[] = [
  {
    name: "grade_workspace",
    description:
      "工作区分级（逆向接入第一步）：按输入契约三级分档扫描全部表——A 规范（双行表头点分列名比例/列生成模式命中率达标）、B 半规范（单行中文表头）、C 裸表（英文驼峰/无中文语义表头），输出工作区判级、逐表分级、覆盖率与孤儿表初判（无外键候选列且无角色候选信号）。分级结果可用 save_structure 固化到 structure.json。",
    parameters: {
      type: "object",
      properties: {},
    },
    access: "read",
    module: "structure",
    execute: async (_params, ctx) => {
      try {
        const index = readIndex(ctx);
        if (!index) return { success: false, error: "工作区索引不存在，请先运行导入脚本" };
        if (!index.tables?.length) return { success: false, error: "工作区索引中无表" };
        const graded = index.tables.map(gradeOneTable);
        const total = graded.length;
        const aCount = graded.filter((t) => t.level === "A").length;
        const cCount = graded.filter((t) => t.level === "C").length;
        const bCount = total - aCount - cCount;
        // 工作区判级：A 级占比 ≥ GRADE_WS_A_MIN 判 A；C 级占比 ≥ GRADE_WS_C_MIN 判 C；否则 B
        const level: "A" | "B" | "C" = aCount / total >= GRADE_WS_A_MIN ? "A" : cCount / total >= GRADE_WS_C_MIN ? "C" : "B";
        const totalCols = index.tables.reduce((s, t) => s + (t.columns?.length ?? 0), 0);
        const totalDotted = index.tables.reduce((s, t) => s + (t.columns ?? []).filter((c) => c.includes(".")).length, 0);
        const totalPatternCols = index.tables.reduce((s, t) => s + Object.keys(t.columnPatterns ?? {}).length, 0);
        const orphanCandidates = graded.filter((t) => t.orphan).map((t) => t.table);
        return {
          success: true,
          data: {
            workspace: index.name,
            grade: {
              level,
              coverage: {
                tableCount: total,
                aTables: aCount,
                bTables: bCount,
                cTables: cCount,
                dottedColumnRatio: totalCols > 0 ? r4(totalDotted / totalCols) : 0,
                patternHitRate: totalCols > 0 ? r4(totalPatternCols / totalCols) : 0,
                orphanCandidateCount: orphanCandidates.length,
              },
            },
            tables: graded,
            orphanCandidates,
            verdict: `工作区判级 ${level}：A 级 ${aCount}/${total}、B 级 ${bCount}/${total}、C 级 ${cCount}/${total}；孤儿表初判 ${orphanCandidates.length} 张${orphanCandidates.length > 0 ? `（${orphanCandidates.join("、")}）` : ""}。A/B 级以机器推断为主，C 级需采样画像 + 假设 + 用户逐条确认`,
          },
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  },
  {
    name: "profile_table",
    description:
      "单表画像（确定性统计，无 LLM）：行数、列类型分布、枚举度（distinct/行数）、单调性（递增/递减/无）、主键候选（唯一且非空列）、累计列校验（某列≈另一列逐行前缀和，取整容差）、角色候选（growth=有等级列且存在等差模式列；master_data=有索引/序号类列；cost=累计列校验成立）。逆向理解单表结构先用它，结论可经 save_structure 固化。",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "目标表名（来自 list_tables）" },
      },
      required: ["table"],
    },
    access: "read",
    module: "structure",
    execute: async (params, ctx) => {
      try {
        const p = (params ?? {}) as { table?: string };
        if (!p.table || typeof p.table !== "string") {
          return { success: false, error: "缺少 table 参数" };
        }
        if (!tablePath(ctx.workspaceRoot, p.table)) {
          return { success: false, error: `非法表名（路径逃逸）: ${p.table}` };
        }
        const rows = loadTableRows(ctx.workspaceRoot, p.table);
        if (!rows) return { success: false, error: `表不存在: ${p.table}，请用 list_tables 确认表名` };
        if (rows.length === 0) return { success: false, error: `表 "${p.table}" 为空表` };

        const columns = Object.keys(rows[0]);
        const columnProfiles = columns.map((col) => profileOneColumn(rows, col));
        const primaryKeyCandidates = rows.length >= 2 ? columnProfiles.filter((c) => c.unique).map((c) => c.column) : [];
        const cumulativeColumns = detectCumulativeColumns(rows, columns);

        // 角色候选（启发式，供用户确认）
        const roleCandidates: { role: string; evidence: string; confidence: number }[] = [];
        const levelCol = columns.find(isLevelColumn);
        // arithmeticCol 搜索排除等级列自身：等级 1..N 恒等差，自引用证据会让任何含等级列表必出 growth 假阳
        const arithmeticCol = columns.find((col) => {
          if (col === levelCol) return false;
          const fit = inferColumnRule(rows.map((r) => r[col]));
          return fit?.best?.type === "arithmetic";
        });
        if (levelCol && arithmeticCol) {
          roleCandidates.push({
            role: "growth",
            evidence: `存在等级类列「${levelCol}」且「${arithmeticCol}」呈等差模式（成长曲线特征）`,
            confidence: 0.8,
          });
        }
        const joinCols = columns.filter(isJoinColumn);
        if (joinCols.length > 0) {
          roleCandidates.push({
            role: "master_data",
            evidence: `存在索引/序号类列（${joinCols.join("、")}），值可能被其他表引用`,
            confidence: 0.6,
          });
        }
        if (cumulativeColumns.length > 0) {
          roleCandidates.push({
            role: "cost",
            evidence: `累计列校验成立：${cumulativeColumns.map((c) => `${c.cumulative} ≈ ${c.base} 逐行前缀和`).join("；")}`,
            confidence: 0.85,
          });
        }

        return {
          success: true,
          data: {
            table: p.table,
            rows: rows.length,
            columns: columnProfiles,
            primaryKeyCandidates,
            cumulativeColumns,
            roleCandidates,
            verdict: `${rows.length} 行 × ${columns.length} 列；主键候选 ${primaryKeyCandidates.length > 0 ? primaryKeyCandidates.join("、") : "无"}；累计列 ${cumulativeColumns.length > 0 ? cumulativeColumns.map((c) => `${c.cumulative}(=${c.base}前缀和)`).join("、") : "无"}；角色候选 ${roleCandidates.length > 0 ? roleCandidates.map((c) => c.role).join("/") : "无（孤儿表信号）"}`,
          },
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  },
  {
    name: "infer_foreign_keys",
    description:
      "表间外键推断（值域包含检测，确定性）：from 列非空值域 ⊆ to 列值域、悬挂率 <5% 才成立，from 非空值 ≥3 防巧合；confidence = (1-悬挂率)×值域大小因子。输出候选关系边（kind=foreign_key，不落盘，供用户确认后经 save_structure 固化）。可指定 fromTable/toTable 定向检测；缺省全表两两扫描（输出按置信度排序的 topN 防爆炸）。",
    parameters: {
      type: "object",
      properties: {
        fromTable: { type: "string", description: "引用方表名（与 toTable 成对指定）" },
        toTable: { type: "string", description: "被引用方表名（与 fromTable 成对指定）" },
        topN: { type: "number", description: "全表扫描模式下输出候选数上限（默认 20，最大 50）" },
      },
    },
    access: "read",
    module: "structure",
    execute: async (params, ctx) => {
      try {
        const p = (params ?? {}) as { fromTable?: string; toTable?: string; topN?: number };
        if ((p.fromTable && !p.toTable) || (!p.fromTable && p.toTable)) {
          return { success: false, error: "fromTable 与 toTable 需成对指定（或都不传做全表扫描）" };
        }

        let pairs: [string, string][];
        if (p.fromTable && p.toTable) {
          // 定向模式：直接读两表，不依赖工作区索引
          for (const name of [p.fromTable, p.toTable]) {
            if (!tablePath(ctx.workspaceRoot, name)) {
              return { success: false, error: `非法表名（路径逃逸）: ${name}` };
            }
            if (!loadTableRows(ctx.workspaceRoot, name)) {
              return { success: false, error: `表不存在: ${name}，请用 list_tables 确认表名` };
            }
          }
          pairs = [[p.fromTable, p.toTable]];
        } else {
          const index = readIndex(ctx);
          if (!index) return { success: false, error: "工作区索引不存在，请先运行导入脚本" };
          const tables = index.tables.map((t) => t.table);
          if (tables.length < 2) return { success: false, error: "工作区表数不足 2，无法做跨表推断" };
          if (tables.length > FK_MAX_SCAN_TABLES) {
            return { success: false, error: `表数 ${tables.length} 超出全表扫描上限 ${FK_MAX_SCAN_TABLES}，请用 fromTable/toTable 定向检测` };
          }
          pairs = [];
          for (const a of tables) for (const b of tables) if (a !== b) pairs.push([a, b]);
        }

        // 域缓存：每表每列一次性构建值域
        const domains = new Map<string, Map<string, ColumnDomain>>();
        const unreadable: string[] = [];
        for (const [a, b] of pairs) {
          for (const name of [a, b]) {
            if (domains.has(name)) continue;
            const rows = loadTableRows(ctx.workspaceRoot, name);
            if (!rows) {
              unreadable.push(name);
              domains.set(name, new Map());
              continue;
            }
            domains.set(name, columnDomains(rows));
          }
        }

        const candidates: RelationEdge[] = [];
        for (const [fromTable, toTable] of pairs) {
          const fromDom = domains.get(fromTable)!;
          const toDom = domains.get(toTable)!;
          for (const [fromCol, fd] of fromDom) {
            if (fd.nonNull < FK_MIN_NONNULL || fd.domain.size === 0) continue;
            const fromValues = [...fd.domain];
            for (const [toCol, td] of toDom) {
              if (fromTable === toTable && fromCol === toCol) continue;
              if (td.domain.size === 0) continue;
              const dangling = fromValues.filter((v) => !td.domain.has(v)).length;
              const danglingRate = dangling / fromValues.length;
              if (danglingRate >= FK_DANGLING_MAX) continue;
              // 值域大小因子：独立值越多证据越足（≥10 个满格），与悬挂率相乘
              const sizeFactor = Math.min(1, Math.log(fd.domain.size + 1) / Math.log(11));
              candidates.push({
                from: { table: fromTable, column: fromCol },
                to: { table: toTable, column: toCol },
                kind: "foreign_key",
                confidence: r4((1 - danglingRate) * sizeFactor),
                status: "inferred",
                evidence: [
                  `${fromTable}.${fromCol} 的 ${fd.domain.size} 个独立值中 ${dangling} 个不在 ${toTable}.${toCol} 值域（悬挂率 ${(danglingRate * 100).toFixed(1)}%）`,
                ],
                danglingRate: r4(danglingRate),
              });
            }
          }
        }

        candidates.sort(
          (x, y) => y.confidence - x.confidence ||
            `${x.from.table}.${x.from.column}`.localeCompare(`${y.from.table}.${y.from.column}`)
        );
        // topN 守卫：非有限数值（NaN/Infinity）回退默认值（NaN 透传会让 slice(0, NaN) 输出空清单）
        const topN = Math.min(
          Math.max(1, Math.trunc(typeof p.topN === "number" && Number.isFinite(p.topN) ? p.topN : FK_TOP_N_DEFAULT)),
          FK_TOP_N_MAX
        );
        const output = candidates.slice(0, topN);
        const truncated = candidates.length > output.length;
        return {
          success: true,
          data: {
            scannedTablePairs: pairs.length,
            unreadableTables: unreadable.length > 0 ? unreadable : undefined,
            totalCandidates: candidates.length,
            truncated,
            candidates: output,
            verdict:
              candidates.length === 0
                ? `扫描 ${pairs.length} 个有向表对，未发现值域包含的外键候选（悬挂率均 ≥5% 或非空值不足）`
                : `发现 ${candidates.length} 条外键候选${truncated ? `（按置信度输出前 ${output.length} 条）` : ""}——候选为 inferred 态，需用户确认后经 save_structure 固化，未确认关联不得作为改表依据`,
          },
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  },
  {
    name: "save_structure",
    description:
      "把结构 IR（表卡/字段卡/关系边/意图卡/判级）写入工作区 structure.json sidecar，与现有 IR 增量去重合并。结构 IR 与数值表分离——写结构不碰数值表；confirmed 状态由用户会话确认后写入，推断重跑不会覆盖已确认/已拒绝的裁决。推断候选先经用户逐条确认再存入。",
    parameters: {
      type: "object",
      properties: {
        structure: {
          type: "object",
          description:
            "WorkspaceStructure 或局部增量：{tables?[{table,role?,roleStatus,primaryKey?,confidence,evidence}], fields?, relations?[{from:{table,column},to:{table,column},kind:foreign_key|derived|aggregate,confidence,status,evidence}], orphanTables?, intents?, grade?{level,coverage}}",
        },
      },
      required: ["structure"],
    },
    access: "write",
    module: "structure",
    execute: async (params, ctx) => {
      try {
        const p = (params ?? {}) as { structure?: unknown };
        if (!p.structure || typeof p.structure !== "object" || Array.isArray(p.structure)) {
          return { success: false, error: "缺少 structure 参数（WorkspaceStructure 或局部增量对象）" };
        }
        const { patch, error } = normalizeStructurePatch(p.structure as Record<string, unknown>);
        if (error || !patch) return { success: false, error: error ?? "structure 参数不合法" };

        const existing = loadStructure(ctx.workspaceRoot) ?? emptyStructure();
        const merged: WorkspaceStructure = mergeStructure(existing, patch);
        saveStructure(ctx.workspaceRoot, merged);
        return {
          success: true,
          data: {
            path: "structure.json",
            mergedCounts: {
              tables: merged.tables.length,
              fields: merged.fields.length,
              relations: merged.relations.length,
              intents: merged.intents.length,
            },
            note: "结构 IR 与数值表分离（不写 tables/）；confirmed 状态由用户会话确认后写入，推断重跑不覆盖终态",
          },
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  },
];
