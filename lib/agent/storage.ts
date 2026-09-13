/**
 * 工作区存储层 — fs 基底 + 实例内存覆盖（overlay）
 *
 * 部署形态差异：本机 fs 可写（改表直接落盘+.bak）；Vercel 等只读文件系统上，
 * git 提交的表作为只读基底可查，写操作落到实例级 overlay（同一温实例内
 * 读写自洽——apply-write 落盘后 agent 复核能读到新值）。冷启动/多实例回滚到
 * 基底是演示环境的已知边界；生产持久化接 Supabase/Blob（见架构一页纸债务节）。
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { join, resolve, sep, dirname } from "path";

/** 实例级覆盖层：表路径 → 当前行数据 / 上一步备份 */
const overlayRows = new Map<string, Record<string, unknown>[]>();
const overlayBak = new Map<string, Record<string, unknown>[]>();
const overlayText = new Map<string, string>();

/** 测试钩子：强制走 overlay 分支（模拟只读部署环境的写入路径） */
let forceOverlay = false;
export function __setForceOverlayForTests(v: boolean): void {
  forceOverlay = v;
}

export function tablePath(workspaceRoot: string, table: string): string | null {
  const root = resolve(workspaceRoot);
  const p = resolve(join(root, "tables", `${table}.json`));
  if (p !== root && !p.startsWith(root + sep)) return null;
  return p;
}

/** 读表：overlay 优先 → fs 基底；不存在返回 null */
export function loadTableRows(workspaceRoot: string, table: string): Record<string, unknown>[] | null {
  const p = tablePath(workspaceRoot, table);
  if (!p) return null;
  const ovr = overlayRows.get(p);
  if (ovr) return ovr;
  try {
    const rows = JSON.parse(readFileSync(p, "utf-8"));
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

/**
 * 写表（改表落盘）：fs 可写则真落盘并做 .bak；否则仅 overlay（bak 也 overlay）。
 * 返回写模式，供结果声明（线上演示时如实标注「实例内生效」）。
 */
export function persistTableRows(
  workspaceRoot: string,
  table: string,
  rows: Record<string, unknown>[]
): { mode: "disk" | "overlay" } {
  const p = tablePath(workspaceRoot, table);
  if (!p) throw new Error(`非法表名（路径逃逸）: ${table}`);
  const bakKey = `${p}.bak`;
  if (!forceOverlay) {
    try {
      const current = JSON.parse(readFileSync(p, "utf-8")) as unknown;
      if (Array.isArray(current)) copyFileSync(p, bakKey);
      writeFileSync(p, JSON.stringify(rows, null, 2), "utf-8");
      return { mode: "disk" };
    } catch {
      // fs 只读（serverless）→ 落入下方 overlay 分支
    }
  }
  // overlay：当前基底内容作为 bak，新值入 overlay
  try {
    const base = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (Array.isArray(base) && !overlayBak.has(bakKey)) overlayBak.set(bakKey, base);
  } catch {
    if (!overlayBak.has(bakKey)) overlayBak.set(bakKey, []);
  }
  overlayRows.set(p, rows);
  return { mode: "overlay" };
}

/** 撤销最近一次写：优先 overlay bak → fs bak；无备份返回 false */
export function restoreTable(workspaceRoot: string, table: string): boolean {
  const p = tablePath(workspaceRoot, table);
  if (!p) return false;
  const bakKey = `${p}.bak`;
  const ovrBak = overlayBak.get(bakKey);
  if (ovrBak) {
    overlayRows.set(p, ovrBak);
    overlayBak.delete(bakKey);
    return true;
  }
  if (existsSync(bakKey)) {
    copyFileSync(bakKey, p);
    return true;
  }
  return false;
}

/** 追加文本（记忆流）：fs 可写则追加；否则 overlay 追加（以 fs 基底为初值——只读部署下基底可读） */
export function appendWorkspaceText(filePath: string, text: string): void {
  if (!forceOverlay) {
    try {
      const dir = filePath.substring(0, filePath.lastIndexOf(sep));
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(filePath, text, "utf-8");
      return;
    } catch {
      // fs 只读（serverless）→ 落入下方 overlay 分支
    }
  }
  // overlay 初值取 fs 基底：否则读侧只见追加尾巴、丢掉 git 提交的记忆内容
  const base = overlayText.has(filePath) ? overlayText.get(filePath)! : (() => {
    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      return "";
    }
  })();
  overlayText.set(filePath, base + text);
}

/**
 * 全量覆写文本（framework.json / questionnaire-state.json 等 JSON 对象文件）：
 * fs 可写则直接写（无 .bak——产物由输入确定性可重算，见 finalize 契约）；
 * 失败落入 overlay（全量覆写语义，不与基底拼接）。
 */
export function writeWorkspaceText(filePath: string, content: string): { mode: "disk" | "overlay" } {
  if (!forceOverlay) {
    try {
      // dirname 提取目录（substring+lastIndexOf 在 posix 风格分隔符路径下误判）
      const dir = dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, content, "utf-8");
      return { mode: "disk" };
    } catch {
      // fs 只读（serverless）→ 落入下方 overlay 分支
    }
  }
  overlayText.set(filePath, content);
  return { mode: "overlay" };
}

/** 读文本（记忆/索引）：overlay 优先 → fs */
export function loadWorkspaceText(filePath: string): string | null {
  const ovr = overlayText.get(filePath);
  if (ovr !== undefined) return ovr;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

// ==================== 覆盖层跨实例持久化访问器（overlay-store 消费） ====================

/**
 * 水合一条覆盖层（来自持久化存储的回灌）。仅当本实例内存无该条时写入——
 * 本实例更新鲜的状态（如刚 apply-write 过）不被陈旧回灌覆盖
 */
export function hydrateOverlayEntry(
  filePath: string,
  rows: Record<string, unknown>[],
  bak?: Record<string, unknown>[] | null,
): void {
  if (!overlayRows.has(filePath)) overlayRows.set(filePath, rows);
  if (bak && !overlayBak.has(`${filePath}.bak`)) overlayBak.set(`${filePath}.bak`, bak);
}

/** 当前覆盖层快照（无覆盖返回 null）——apply-write 后推送到持久化存储用 */
export function getOverlayEntry(
  filePath: string,
): { rows: Record<string, unknown>[]; bak: Record<string, unknown>[] | null } | null {
  const rows = overlayRows.get(filePath);
  if (!rows) return null;
  return { rows, bak: overlayBak.get(`${filePath}.bak`) ?? null };
}

/** 水合文本覆盖层（记忆追加层回灌）：本实例已有内容时不覆盖（本实例更新鲜） */
export function hydrateTextEntry(filePath: string, content: string): void {
  if (!overlayText.has(filePath)) overlayText.set(filePath, content);
}

/**
 * 枚举指定工作区根目录下的全部文本覆盖层（严格目录边界：filePath 位于
 * rootPrefix 自身或其子目录内）——pushTextOverlay 泛化推送消费。
 * overlayText 是模块级单例、key 为绝对路径、跨工作区共享，消费方必须按
 * 前缀过滤，否则会把 A 工作区条目以 B 的 workspaceId upsert 入库。
 */
export function listTextOverlaysUnder(workspaceRoot: string): { filePath: string; content: string }[] {
  const prefix = resolve(workspaceRoot);
  const out: { filePath: string; content: string }[] = [];
  for (const [filePath, content] of overlayText) {
    const resolved = resolve(filePath);
    if (resolved === prefix || resolved.startsWith(prefix + sep)) {
      out.push({ filePath, content });
    }
  }
  return out;
}

/** 测试辅助：清空实例 overlay */
export function __resetOverlayForTests(): void {
  overlayRows.clear();
  overlayBak.clear();
  overlayText.clear();
}
