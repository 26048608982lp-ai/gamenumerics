/**
 * 列间派生关系推断 — 从两列（或整表数值列两两）反推跨列生成结构
 *
 * 数值表的列常由同一基准派生（如强化表各装备攻击 = 基准 × 装备划分系数），
 * 各列独立取整后比率只在真值附近浮动。本层按「取整半格容限」推断
 * 「B 列 ≈ A 列 × k」的系数关系并标出偏离行，供表结构发现（基准列还原）
 * 与跨表对照（系数表 ↔ 明细表，由 agent 编排 read_table 后连线）消费。
 *
 * 与 pattern.ts 的分工：pattern 推「列内规律」（值随行序怎么走），
 * relation 推「列间结构」（列与列谁派生谁）——同一张表的两个正交视角。
 */

export interface PairOutlier {
  /** 0 起行号 */
  index: number;
  a: number;
  b: number;
  expected: number;
}

export interface PairRelation {
  kind: "identity" /** B = A（比率 1，双列同源拷贝） */ | "ratio" /** B = A × k */ | "none";
  /** B/A 比率（干净行 Σb/Σa 精化；identity 为 1，none 为 null） */
  ratio: number | null;
  /** 容限内行占比（0~1，none 时仍报告供参考） */
  fitPct: number;
  outliers: PairOutlier[];
  validRows: number;
  skippedRows: number;
  evidence: string;
}

export interface RelationOptions {
  /** 相对容差百分比（默认 1，与 infer_column_rule 同口径；取整半格容限与之取大） */
  thresholdPct?: number;
  /** 偏离占比上限（默认 0.2）：超出判 none（宁缺勿滥，与列规则立论线一致） */
  maxOutlierRatio?: number;
}

/** 相对浮点容差：identity 判定线（拷贝列的浮点尾数不干扰） */
const REL_EPS = 1e-3;

type ValidRow = { index: number; a: number; b: number };

/** 配对两列：同为有限数值且 a≠0（比率定义要求）；任一列恒定则比率无意义 */
function pairRows(a: unknown[], b: unknown[]): ValidRow[] {
  const rows: ValidRow[] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    if (typeof x === "number" && Number.isFinite(x) && x !== 0 && typeof y === "number" && Number.isFinite(y)) {
      rows.push({ index: i, a: x, b: y });
    }
  }
  return rows;
}

function isConstant(nums: number[]): boolean {
  return nums.length > 0 && nums.every((v) => Math.abs(v - nums[0]) <= REL_EPS * Math.max(Math.abs(nums[0]), 1));
}

/** 行是否在容限内：b 与 a 各自取整损失 ≤0.5，乘比率传播后合计 ≤0.5×(1+|k|)；
 * 与相对容差取大（浮点噪声兜底）——双侧取整是「基准×系数」列的物理生成方式 */
function withinTolerance(b: number, expected: number, ratio: number, thresholdPct: number): boolean {
  return Math.abs(b - expected) <= Math.max(0.5 * (1 + Math.abs(ratio)), (Math.abs(expected) * thresholdPct) / 100);
}

/**
 * 两列派生关系推断：B ≈ A × k。
 * 比率中位数作稳健初值（离群行不拉偏）→ 容限内行 Σb/Σa 精化（取整误差
 * 互相抵消）——与列规则推断的 Theil-Sen 初值 + OLS 精化同构。
 */
export function inferPairRelation(a: unknown[], b: unknown[], options?: RelationOptions): PairRelation {
  const thresholdPct = options?.thresholdPct ?? 1;
  const maxOutlierRatio = options?.maxOutlierRatio ?? 0.2;

  const rows = pairRows(a, b);
  const skippedRows = Math.max(a.length, b.length) - rows.length;
  const validRows = rows.length;

  const none = (reason: string): PairRelation => ({
    kind: "none",
    ratio: null,
    fitPct: 0,
    outliers: [],
    validRows,
    skippedRows,
    evidence: reason,
  });

  if (validRows < 3) return none(`有效配对行不足（${validRows} < 3，需两列同为数值且被除列非 0）`);
  // 任一列恒定时比率退化为常数除法，推不出跨列结构
  if (isConstant(rows.map((r) => r.a)) || isConstant(rows.map((r) => r.b))) {
    return none("两列中存在恒定列，比率无跨列结构意义");
  }

  const ratioSamples = rows.map((r) => r.b / r.a).sort((x, y) => x - y);
  const mid = Math.floor(ratioSamples.length / 2);
  const initial =
    ratioSamples.length % 2 === 1 ? ratioSamples[mid] : (ratioSamples[mid - 1] + ratioSamples[mid]) / 2;

  // 初值定位偏离行 → 占比内剔除后 Σb/Σa 精化（无偏、取整噪声抵消）
  let ratio = initial;
  const badInitial = rows.filter((r) => !withinTolerance(r.b, r.a * initial, initial, thresholdPct));
  if (badInitial.length <= rows.length * maxOutlierRatio && rows.length - badInitial.length >= 3) {
    const clean = rows.filter((r) => withinTolerance(r.b, r.a * initial, initial, thresholdPct));
    ratio = clean.reduce((s, r) => s + r.b, 0) / clean.reduce((s, r) => s + r.a, 0);
  }

  const outliers = rows
    .filter((r) => !withinTolerance(r.b, r.a * ratio, ratio, thresholdPct))
    .map((r) => ({ index: r.index, a: r.a, b: r.b, expected: Number((r.a * ratio).toFixed(4)) }));
  const fitPct = Number((1 - outliers.length / validRows).toFixed(4));

  if (fitPct < 1 - maxOutlierRatio - 1e-9) {
    return none(`比率不成立（中位比率 ${Number(initial.toFixed(4))}，仅 ${(fitPct * 100).toFixed(1)}% 行在容限内，低于立论线 ${Math.round((1 - maxOutlierRatio) * 100)}%）`);
  }

  const ratioRounded = Number(ratio.toFixed(6));
  const kind: PairRelation["kind"] = Math.abs(ratio - 1) <= REL_EPS ? "identity" : "ratio";
  const evidence =
    kind === "identity"
      ? `B ≡ A（比率 1，${validRows} 行全吻合——双列同源拷贝）`
      : `B ≈ A × ${ratioRounded}（${validRows} 行中 ${(fitPct * 100).toFixed(1)}% 在取整容限内${outliers.length > 0 ? `，${outliers.length} 行偏离` : ""}）`;
  return { kind, ratio: ratioRounded, fitPct, outliers, validRows, skippedRows, evidence };
}

/* ────────────────────────────────────────────────────────────
 * 整表列间结构 — inferTableRelations（宽表两两矩阵 + 基准列发现）
 *
 * 基准列 = 与最多其他列构成系数关系的列（如强化表的太刀列，其余装备
 * 攻击列均 ≈ 太刀 × 装备系数）——即该表数值结构的「锚」。
 * ──────────────────────────────────────────────────────────── */

export interface TableRelationEntry {
  /** 相对基准列的派生描述（基准列自身为 identity 描述） */
  baseColumn: string | null;
  columns: { column: string; kind: PairRelation["kind"] | "base"; ratio: number | null; fitPct: number; evidence: string }[];
  /** 全部成立的关系对（kind ≠ none），供跨表对照与溯源 */
  pairs: { a: string; b: string; relation: PairRelation }[];
  /** 参与推断的数值列（剔除恒定/非数值列后的清单） */
  numericColumns: string[];
  /** 被剔除的列及原因（恒定/非数值/列数超限未参与） */
  excludedColumns: { column: string; reason: string }[];
}

/** 两两配对数上限（宽表保护：超出提示指定列子集；49 列宽表约 460 对，留足余量） */
const MAX_PAIRS = 600;

/** 数值列判定：有限数值行 ≥3（恒定列参与只会得 none，预先剔除降配对量） */
function numericColumnEntries(columns: Record<string, unknown[]>): { kept: string[]; excluded: { column: string; reason: string }[] } {
  const kept: string[] = [];
  const excluded: { column: string; reason: string }[] = [];
  for (const [name, values] of Object.entries(columns)) {
    const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (nums.length < 3) {
      excluded.push({ column: name, reason: "数值行不足 3" });
    } else if (isConstant(nums)) {
      excluded.push({ column: name, reason: "恒定列（无跨列结构意义）" });
    } else {
      kept.push(name);
    }
  }
  return { kept, excluded };
}

/**
 * 整表列间结构推断：数值列两两配对推断系数关系，并发现基准锚点列
 * （并列时取列名序——锚点只是表述参照，跨表对照以 pairs 全集为准，
 * 相对比率与锚点选择无关）。恒定列/非数值列自动剔除并说明原因；
 * 两两配对数超上限时不产出关系，在 excludedColumns 提示指定列子集。
 */
export function inferTableRelations(
  columns: Record<string, unknown[]>,
  options?: RelationOptions
): TableRelationEntry {
  const { kept, excluded } = numericColumnEntries(columns);
  const pairCount = (kept.length * (kept.length - 1)) / 2;
  if (pairCount > MAX_PAIRS) {
    excluded.push({ column: "(全部)", reason: `数值列 ${kept.length} 列两两 ${pairCount} 对，超出 ${MAX_PAIRS} 上限——请指定 columns 子集` });
    return { baseColumn: null, columns: [], pairs: [], numericColumns: kept, excludedColumns: excluded };
  }

  const pairs: TableRelationEntry["pairs"] = [];
  for (let i = 0; i < kept.length; i += 1) {
    for (let j = i + 1; j < kept.length; j += 1) {
      const relation = inferPairRelation(columns[kept[i]], columns[kept[j]], options);
      if (relation.kind !== "none") {
        pairs.push({ a: kept[i], b: kept[j], relation });
      }
    }
  }

  // 基准列 = 在成立关系对中出现次数最多的列（并列取列名序，保证确定性）
  const degree = new Map<string, number>();
  for (const p of pairs) {
    degree.set(p.a, (degree.get(p.a) ?? 0) + 1);
    degree.set(p.b, (degree.get(p.b) ?? 0) + 1);
  }
  let baseColumn: string | null = null;
  let bestDegree = 0;
  for (const name of [...degree.keys()].sort()) {
    const d = degree.get(name) ?? 0;
    if (d > bestDegree) {
      bestDegree = d;
      baseColumn = name;
    }
  }

  const columnReports: TableRelationEntry["columns"] = [
    ...kept
      .filter((name) => name !== baseColumn)
      .map((name) => {
        const hit = pairs.find(
          (p) => (p.a === baseColumn && p.b === name) || (p.b === baseColumn && p.a === name)
        );
        if (!hit) {
          return { column: name, kind: "none" as const, ratio: null, fitPct: 0, evidence: "与基准列无成立系数关系" };
        }
        // 统一表述为「该列 = 基准 × k」：hit.a→hit.b 的 ratio 是 b/a
        const forward = hit.b === name;
        const ratio = forward ? hit.relation.ratio : hit.relation.ratio !== null ? Number((1 / hit.relation.ratio).toFixed(6)) : null;
        return { column: name, kind: hit.relation.kind, ratio, fitPct: hit.relation.fitPct, evidence: hit.relation.evidence };
      }),
    ...(baseColumn
      ? [{ column: baseColumn, kind: "base" as const, ratio: 1, fitPct: 1, evidence: "基准列（与最多列构成系数关系）" }]
      : []),
  ];

  return { baseColumn, columns: columnReports, pairs, numericColumns: kept, excludedColumns: excluded };
}
