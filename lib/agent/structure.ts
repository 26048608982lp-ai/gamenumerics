/**
 * L2 结构 IR 层 — structure.json sidecar 的类型、读写与状态机（纯 fs，无 LLM）
 *
 * 结构 IR 与数值表分离（sidecar 可 git 版本化，不进 Supabase）；推断工具产出
 * inferred 态卡片，用户会话逐条确认后经 save_structure + mergeStructure 写入
 * confirmed/rejected——推断重跑不冲掉用户裁决（confirmed 恒保护；rejected 仅
 * 可被 confirmed 改判翻案）。读写双模：磁盘可写直接原子写（tmp→rename），
 * 只读部署（serverless）降级实例内存 overlay——与 storage.persistTableRows
 * 同构。路径沙箱沿用 storage.tablePath 模式（resolve 后必须落在 workspaceRoot 内）。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { join, resolve, sep, dirname } from "path";

/** 卡片状态机：inferred（机器推断）→ confirmed | rejected（用户裁决）；保守侧实现——推断产物恒 inferred 待用户确认，「确定性关系自动 confirmed」留作未来增强 */
export type StructureStatus = "inferred" | "confirmed" | "rejected";

/** 表卡：表的角色归位（成长表/主数据/消耗表…） */
export interface TableCard {
  table: string;
  role?: string;
  roleStatus: StructureStatus;
  primaryKey?: string;
  grain?: string;
  confidence: number;
  evidence: string[];
}

/** 字段卡：列的语义标注（P2 扩展位） */
export interface FieldCard {
  table: string;
  column: string;
  semanticType?: string;
  unit?: string;
  enumCardinality?: number;
  status: StructureStatus;
}

export type RelationKind = "foreign_key" | "derived" | "aggregate";

export interface RelationEndpoint {
  table: string;
  column: string;
}

/** 关系边：跨表外键 / 列间派生 / 聚合（如累计列） */
export interface RelationEdge {
  from: RelationEndpoint;
  to: RelationEndpoint;
  kind: RelationKind;
  confidence: number;
  status: StructureStatus;
  evidence: string[];
  /** from 值不在 to 值域中的比例（外键专用，0~1） */
  danglingRate?: number;
}

/** L1 意图卡（P2）：陈述 + 证据引用 + 置信度 + 状态 + 消费方 */
export interface IntentCard {
  id: string;
  statement: string;
  evidence: string[];
  confidence: number;
  status: "proposed" | "confirmed" | "rejected";
  consumers: string[];
}

export interface StructureGrade {
  level: "A" | "B" | "C";
  coverage: Record<string, unknown>;
}

export interface WorkspaceStructure {
  version: 1;
  gradedAt?: string;
  grade?: StructureGrade;
  tables: TableCard[];
  fields: FieldCard[];
  relations: RelationEdge[];
  /** 无关系边且无角色归位的表（诚实报告） */
  orphanTables: string[];
  intents: IntentCard[];
}

/** 增量写入形状：未提供的 section 保留现状 */
export type StructurePatch = Partial<WorkspaceStructure>;

/** structure.json 路径解析（沙箱守卫与 storage.tablePath 同构：resolve 后必须落在 root 内） */
export function structurePath(workspaceRoot: string): string | null {
  const root = resolve(workspaceRoot);
  const p = resolve(join(root, "structure.json"));
  if (p !== root && !p.startsWith(root + sep)) return null;
  return p;
}

/** 空 IR（首次写入的合并基底） */
export function emptyStructure(): WorkspaceStructure {
  return { version: 1, tables: [], fields: [], relations: [], orphanTables: [], intents: [] };
}

/** 实例级覆盖层：structure.json 绝对路径 → 序列化内容（只读部署降级，与 storage overlay 同构） */
const structureOverlay = new Map<string, string>();

/** 测试钩子：强制走 overlay 分支（模拟只读部署环境的写入路径） */
let forceOverlay = false;
export function __setStructureForceOverlayForTests(v: boolean): void {
  forceOverlay = v;
}

/** 测试辅助：清空结构 overlay */
export function __resetStructureOverlayForTests(): void {
  structureOverlay.clear();
}

/** 数组 section 形状防御：非数组置空数组；数组内非对象元素剔除（防手编坏 JSON 致下游 TypeError） */
function sanitizeObjectArray<T>(v: unknown): T[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is T => x !== null && typeof x === "object" && !Array.isArray(x));
}

/**
 * 读结构 IR：文件不存在/坏 JSON/形状不对 → null（防御，不抛错）。
 * overlay 优先 → 磁盘；全部 section 形状收窄——route.ts 装配段对
 * relations/intents/orphanTables 做 filter/join，坏形状若透传会让 /api/agent 全 500。
 */
export function loadStructure(workspaceRoot: string): WorkspaceStructure | null {
  const p = structurePath(workspaceRoot);
  if (!p) return null;
  const ovr = structureOverlay.get(p);
  if (ovr === undefined && !existsSync(p)) return null;
  try {
    const parsed = JSON.parse(ovr ?? readFileSync(p, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as WorkspaceStructure).tables)) {
      return null;
    }
    const raw = parsed as WorkspaceStructure;
    // tables 元素必须带非空 table 键（合并去重与角色清单的主键），缺键卡剔除
    const tables = sanitizeObjectArray<TableCard>(raw.tables).filter(
      (t): t is TableCard => typeof t.table === "string" && t.table !== ""
    );
    const out: WorkspaceStructure = {
      version: 1,
      tables,
      fields: sanitizeObjectArray<FieldCard>(raw.fields),
      relations: sanitizeObjectArray<RelationEdge>(raw.relations),
      orphanTables: Array.isArray(raw.orphanTables)
        ? raw.orphanTables.filter((t): t is string => typeof t === "string")
        : [],
      intents: sanitizeObjectArray<IntentCard>(raw.intents),
    };
    if (typeof raw.gradedAt === "string") out.gradedAt = raw.gradedAt;
    if (raw.grade && typeof raw.grade === "object" && !Array.isArray(raw.grade)) out.grade = raw.grade;
    return out;
  } catch {
    return null;
  }
}

/** 写结构 IR：路径沙箱 + 原子写（先 tmp 再 rename，读侧永不见半截文件）；fs 只读（serverless）降级实例 overlay */
export function saveStructure(workspaceRoot: string, structure: WorkspaceStructure): void {
  const p = structurePath(workspaceRoot);
  if (!p) throw new Error(`非法工作区路径（路径逃逸）: ${workspaceRoot}`);
  const serialized = JSON.stringify(structure, null, 2);
  if (!forceOverlay) {
    try {
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, serialized, "utf-8");
      renameSync(tmp, p);
      structureOverlay.delete(p); // 磁盘已是最新，清掉可能存在的陈旧 overlay（overlay 优先读会遮蔽磁盘）
      return;
    } catch {
      // fs 只读（EROFS/serverless）→ 落入下方 overlay 分支
    }
  }
  structureOverlay.set(p, serialized);
}

/** 关系边的去重键（from/to + kind 唯一确定一条边） */
export function relationKey(from: RelationEndpoint, to: RelationEndpoint, kind: RelationKind): string {
  return `${from.table}§${from.column}→${to.table}§${to.column}#${kind}`;
}

/**
 * section 级合并（裁决方向）：同键项按 existing 状态裁决——confirmed 恒保护；
 * rejected 仅当 incoming 同键改判为 confirmed 时放行（用户主动翻案），inferred
 * 重跑不复活；inferred 态随时被新推断更新；incoming 独有项追加。
 */
function mergeSection<T>(existing: T[], incoming: T[] | undefined, keyOf: (item: T) => string, statusOf: (item: T) => string): T[] {
  if (!incoming) return existing;
  if (existing.length === 0) return [...incoming];
  const map = new Map<string, T>();
  for (const item of existing) map.set(keyOf(item), item);
  for (const item of incoming) {
    const cur = map.get(keyOf(item));
    if (!cur) {
      map.set(keyOf(item), item);
      continue;
    }
    if (statusOf(cur) === "confirmed") continue;
    if (statusOf(cur) === "rejected" && statusOf(item) !== "confirmed") continue;
    map.set(keyOf(item), item);
  }
  return [...map.values()];
}

/**
 * 结构 IR 合并：按 table / table.column / relationKey / intent id 去重。
 * incoming（推断重跑结果）不覆盖 existing 的 confirmed/rejected 终态——唯一例外是
 * rejected → confirmed 的用户改判；orphanTables 为重算型数据——incoming 显式提供
 * （含空数组）时替换，缺省保留。
 */
export function mergeStructure(existing: WorkspaceStructure, incoming: StructurePatch): WorkspaceStructure {
  return {
    version: 1,
    gradedAt: incoming.gradedAt ?? existing.gradedAt,
    grade: incoming.grade ?? existing.grade,
    tables: mergeSection(existing.tables, incoming.tables, (t) => t.table, (t) => t.roleStatus),
    fields: mergeSection(existing.fields, incoming.fields, (f) => `${f.table}.${f.column}`, (f) => f.status),
    relations: mergeSection(existing.relations, incoming.relations, (r) => relationKey(r.from, r.to, r.kind), (r) => r.status),
    intents: mergeSection(existing.intents, incoming.intents, (i) => i.id, (i) => i.status),
    orphanTables: incoming.orphanTables ?? existing.orphanTables,
  };
}

/**
 * 孤儿表计算：既无角色归位（卡片有 role 且未被拒绝）又未出现在任何
 * 非拒绝关系边中的表——"不理解"比"错误理解"诚实，显式报告。
 */
export function computeOrphanTables(
  tables: string[],
  cards: { table: string; role?: string; roleStatus: StructureStatus }[],
  relations: { from: { table: string }; to: { table: string }; status: StructureStatus }[]
): string[] {
  const placed = new Set<string>();
  for (const card of cards) {
    if (card.role !== undefined && card.roleStatus !== "rejected") placed.add(card.table);
  }
  for (const rel of relations) {
    if (rel.status === "rejected") continue;
    placed.add(rel.from.table);
    placed.add(rel.to.table);
  }
  return tables.filter((t) => !placed.has(t)).sort();
}

/** statement 单行截断上限：固化 facts.md 一行一条，超长/多行陈述不得破坏行格式 */
const INTENT_STATEMENT_MAX = 80;

/**
 * confirmed 意图卡渲染为 markdown（L1 固化格式）：每条
 * `- [id] statement（置信度 xx%；证据：前 2 条）`，供固化到记忆文件消费；
 * statement 压平为单行并截断（防多行/超长陈述破坏 facts.md 行格式）；
 * 无 confirmed 卡返回空串（调用方据此跳过固化段）。
 */
export function intentsToMarkdown(intents: IntentCard[]): string {
  const lines = intents
    .filter((i) => i.status === "confirmed")
    .map((i) => {
      const evidence = i.evidence.length > 0 ? i.evidence.slice(0, 2).join("、") : "无";
      const statement = i.statement.replace(/\s+/g, " ").slice(0, INTENT_STATEMENT_MAX);
      return `- [${i.id}] ${statement}（置信度 ${Math.round(i.confidence * 100)}%；证据：${evidence}）`;
    });
  return lines.join("\n");
}
