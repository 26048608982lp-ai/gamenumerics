/**
 * 表格规范化解析 — 数值策划 Excel 的通用形状（纯函数）
 *
 * 处理三类结构（2026-09-03 外包数据侦察实证）：
 * 1. 双行表头：r1 主表头 + r2 子表头，合并为 `父.子` 复合键
 * 2. 星号继承：r2 为 `*` 或空 = 该列沿用主表头语义
 * 3. 横向分组：r1 空 = 沿用左侧最近的主表头（如「属性划分」横跨 7 属性列）
 *
 * 并排逻辑块宽表（装备强化品质表的 52 列）由导入配置里的 tidy 规则二次拆分，
 * 本层只负责把 sheet 矩阵解析为「列名 → 行对象」的规范形态。
 */

export interface ParsedSheet {
  columns: string[];
  rows: Record<string, unknown>[];
}

function cellText(v: unknown): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

/** 数值样字符串转 number，其余原样（保持字符串枚举/描述文本不受伤） */
function coerceValue(v: unknown): unknown {
  const s = cellText(v);
  if (s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s) ? n : s;
}

/** 双行表头合并：返回每列的规范列名；全空列丢弃（返回 null 占位由调用方过滤） */
function mergeTwoRowHeaders(r1: unknown[], r2: unknown[]): (string | null)[] {
  const width = Math.max(r1.length, r2.length);
  const names: (string | null)[] = [];
  let carryParent = "";

  for (let i = 0; i < width; i += 1) {
    const parent = cellText(r1[i]);
    const child = cellText(r2[i]);

    if (parent) carryParent = parent;
    // 星号或空子表头：继承主表头（「序号」这类单层列）
    if (!child || child === "*") {
      names.push(carryParent || null);
      continue;
    }
    // 有子表头：父.子 复合键（父可能来自横向继承）
    names.push(carryParent ? `${carryParent}.${child}` : child);
  }
  return names;
}

/** 列名去重（返回与输入等长的数组，null 占位空列，保持原始索引对齐）：重复的按 `_2`/`_3` 递增后缀 */
function dedupeColumns(names: (string | null)[]): (string | null)[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    if (!name) return null;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name}_${count + 1}`;
  });
}

/**
 * headerRows 启发式探测：与 mcp-server/src/import-xlsx.ts detectHeaderRows 同源实现
 * （该包独立分发故保留副本），本函数为 lib/table 单源。
 * 首行全为非空字符串（表头特征），且次行满足任一「子表头」特征 → 2：
 *   a) 次行含 null/空单元格（星号继承/单层列——双行表头的典型形状）
 *   b) 次行全部单元格为字符串类型（全「父.子」复合表头——须按原始类型判，
 *      文本化会把数值数据行 1/10 误判为字符串）
 * 其余（首行含空/数值，或次行含数值单元格即数据行）→ 1。矩阵不足两行按 1 兜底。
 */
export function detectHeaderRows(matrix: unknown[][]): 1 | 2 {
  if (matrix.length < 2) return 1;
  const first = matrix[0] ?? [];
  const second = matrix[1] ?? [];
  const width = Math.max(first.length, second.length);
  if (width === 0) return 1;
  const firstTexts = Array.from({ length: width }, (_, i) => cellText(first[i]));
  if (firstTexts.some((t) => t === "")) return 1; // 首行含空 → 非全满父表头
  const secondTexts = Array.from({ length: width }, (_, i) => cellText(second[i]));
  if (secondTexts.some((t) => t === "")) return 2; // a) null/空单元格
  // b) 次行全部单元格为字符串类型（数值单元格 → 数据行 → 1）
  const allStringCells = Array.from({ length: width }, (_, i) => second[i]).every(
    (v) => typeof v === "string"
  );
  return allStringCells ? 2 : 1;
}

/**
 * 解析 sheet 矩阵（AoA，来自 SheetJS sheet_to_json 或等价物）
 * @param matrix 整个 sheet 的单元格矩阵，含表头行
 * @param headerRows 表头行数：1 = 单行（程序导表），2 = 双行（策划导表）
 */
export function parseSheetMatrix(
  matrix: unknown[][],
  headerRows: 1 | 2 = 2
): ParsedSheet {
  if (matrix.length === 0) return { columns: [], rows: [] };

  const rawNames =
    headerRows === 2
      ? mergeTwoRowHeaders(matrix[0] ?? [], matrix[1] ?? [])
      : (matrix[0] ?? []).map((v) => cellText(v) || null);
  const nameByIndex = dedupeColumns(rawNames);
  const columns = nameByIndex.filter((n): n is string => Boolean(n));

  const dataStart = headerRows;
  const rows: Record<string, unknown>[] = [];

  for (const rawRow of matrix.slice(dataStart)) {
    const row: Record<string, unknown> = {};
    let hasValue = false;
    for (let i = 0; i < nameByIndex.length; i += 1) {
      const name = nameByIndex[i];
      if (!name) continue;
      const value = coerceValue(rawRow[i]);
      if (value !== undefined) {
        row[name] = value;
        hasValue = true;
      }
    }
    if (hasValue) rows.push(row);
  }

  return { columns, rows };
}

export interface UnpivotOptions {
  /** 配对键列后缀（如「属性类型」——列名形如 `匕首.属性类型`） */
  keySuffix: string;
  /** 取值列后缀（如「数值」——列名形如 `匕首.数值`） */
  valueSuffix: string;
  /** 前缀值的输出列名（如「装备」=匕首/大刀/…） */
  prefixAs: string;
  /** 行级保留列（品质/等级等宽表每行公共的键） */
  keep: string[];
}

/**
 * 并排逻辑块宽表 → tidy 长表：把 `前缀.键` / `前缀.值` 列对 unpivot 成行。
 * 如装备强化品质表的 12 件装备×(属性类型,数值) 并排 → 每行展开 12 条
 * {…keep 列, 装备: 前缀, 属性类型, 数值}。
 */
export function unpivotColumnPairs(
  rows: Record<string, unknown>[],
  opts: UnpivotOptions
): Record<string, unknown>[] {
  const { keySuffix, valueSuffix, prefixAs, keep } = opts;
  const allColumns = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) allColumns.add(k);

  const prefixes = Array.from(allColumns)
    .filter((c) => c.endsWith(`.${keySuffix}`))
    .map((c) => c.slice(0, -(`.${keySuffix}`).length));

  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    for (const prefix of prefixes) {
      const key = row[`${prefix}.${keySuffix}`];
      const value = row[`${prefix}.${valueSuffix}`];
      if (key === undefined && value === undefined) continue;
      const record: Record<string, unknown> = {};
      for (const col of keep) if (row[col] !== undefined) record[col] = row[col];
      record[prefixAs] = prefix;
      record[keySuffix] = key;
      record[valueSuffix] = value;
      out.push(record);
    }
  }
  return out;
}
