/**
 * 数列模式检测 — 从值序列反推列的生成规则（等差/等比/常数）+ 偏离点审计
 *
 * 数值策划的 Excel 表多由公式生成（如攻击 = 100 + 5×(等级-1)），
 * 导入只留计算结果；本层从值序列反推规则，供改表（apply_curve 以规则重算）
 * 与审计（偏离规则的疑似手调点）消费。
 *
 * inferColumnRule 为运行期容错版：拟合三大曲线族（等差/等比/幂律，数值表
 * 生成规则的主流形态），允许少数手调断点——初值用 Theil-Sen 稳健估计（成对
 * 斜率中位数，离群点不拉偏）定位断点，干净点上再最小二乘精化，带 fitPct
 * 吻合占比作置信度。detectColumnPattern 保持导入期严格识别（全序列吻合
 * 才立论），两者零耦合。
 */

export type ColumnPattern =
  | { type: "geometric"; first: number; ratio: number }
  | { type: "arithmetic"; first: number; diff: number }
  | { type: "constant"; value: number };

/** 相对容差：浮点尾数（如 114.9999999999）不干扰模式识别 */
const REL_EPS = 1e-4;

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) <= REL_EPS * Math.max(Math.abs(a), Math.abs(b), 1);
}

/**
 * 检测数值列的生成模式；非全数值/不足 3 个有效值/无规律 → null
 */
export function detectColumnPattern(values: unknown[]): ColumnPattern | null {
  if (values.length < 3) return null;
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const nums = values as number[];

  if (nums.every((v) => approx(v, nums[0]))) {
    return { type: "constant", value: nums[0] };
  }

  const diffs = nums.slice(1).map((v, i) => v - nums[i]);
  if (diffs.every((d) => approx(d, diffs[0]))) {
    return { type: "arithmetic", first: nums[0], diff: diffs[0] };
  }

  if (nums.every((v) => v > 0)) {
    const ratios = nums.slice(1).map((v, i) => v / nums[i]);
    if (ratios.every((r) => approx(r, ratios[0]))) {
      return { type: "geometric", first: nums[0], ratio: ratios[0] };
    }
  }

  return null;
}

export interface ColumnOutlier {
  /** 0 起行号 */
  index: number;
  value: number;
  expected: number;
  /** 相对期望的偏离百分比（如 2.3 = +2.3%） */
  deviationPct: number;
}

/** 按给定模式重算期望值，报告偏离超过阈值（默认 1%）的点（疑似手调/断点） */
export function detectOutliers(
  values: unknown[],
  pattern: ColumnPattern,
  thresholdPct = 1
): ColumnOutlier[] {
  const outliers: ColumnOutlier[] = [];
  values.forEach((v, i) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return;
    const expected = expectedAt(pattern, i);
    if (expected === null) return;
    const deviationPct = ((v - expected) / expected) * 100;
    if (Math.abs(deviationPct) > thresholdPct) {
      outliers.push({
        index: i,
        value: v,
        expected: Number(expected.toFixed(4)),
        deviationPct: Number(deviationPct.toFixed(2)),
      });
    }
  });
  return outliers;
}

/** 按模式生成第 i 个值（0 起） */
export function expectedAt(pattern: ColumnPattern, i: number): number | null {
  switch (pattern.type) {
    case "constant":
      return pattern.value;
    case "arithmetic":
      return pattern.first + pattern.diff * i;
    case "geometric":
      return pattern.first * Math.pow(pattern.ratio, i);
  }
}

/* ────────────────────────────────────────────────────────────
 * 运行期规则推断 — inferColumnRule（容错拟合版）
 *
 * 与 detectColumnPattern 的分工：导入期严格识别要求全序列吻合（一个手调
 * 断点即整体 null）；运行期推断允许少数断点——Theil-Sen 稳健初值（成对
 * 斜率中位数，离群点不拉偏）先定位断点，干净点上最小二乘精化。
 * ──────────────────────────────────────────────────────────── */

/** 拟合族：等差（含常数，diff=0）/ 等比（即指数形态 a·r^i）/ 幂律 */
export type RuleParams =
  | { type: "arithmetic"; first: number; diff: number }
  | { type: "geometric"; first: number; ratio: number }
  | { type: "power"; first: number; exponent: number };

/** 候选规则：参数 + 吻合占比（容差内行数 / 有效行数，0~1） */
export type RuleFit = RuleParams & { fitPct: number };

export interface InferredRule {
  /** 立论线（吻合占比 ≥ 1 - maxOutlierRatio）内的最优族；不达标为 null（宁缺勿编） */
  best: RuleFit | null;
  /** 全部族候选，按吻合占比降序、同分简单族优先（等差 > 等比 > 幂律） */
  candidates: RuleFit[];
  /** 按 best 参数仍超阈值的行（疑似手调/断点）；best=null 时为空 */
  outliers: ColumnOutlier[];
  validRows: number;
  skippedRows: number;
}

export interface InferOptions {
  /** 偏离阈值百分比（默认 1，与 audit_column/detectOutliers 同口径） */
  thresholdPct?: number;
  /** 断点占比上限（默认 0.2）：超出视为非单一规则（分段/查表），不立论不重拟合 */
  maxOutlierRatio?: number;
}

/** 按拟合参数生成第 i 行期望值（i 为原表行号，0 起） */
export function expectedAtFit(params: RuleParams, i: number): number {
  switch (params.type) {
    case "arithmetic":
      return params.first + params.diff * i;
    case "geometric":
      return params.first * Math.pow(params.ratio, i);
    case "power":
      return params.first * Math.pow(i + 1, params.exponent);
  }
}

type NumericPoint = { index: number; value: number };
type Family = RuleParams["type"];
const FAMILY_ORDER: Record<Family, number> = { arithmetic: 0, geometric: 1, power: 2 };
const r6 = (v: number) => Number(v.toFixed(6));

/** 域变换：等差直接用原值；等比/幂律在 log 域线性化（要求数值全正）。
 * x 取原行号——跳过的非数值行不扭曲规则 */
function toFitDomain(points: NumericPoint[], family: Family): { xs: number[]; ys: number[] } | null {
  if (family === "arithmetic") {
    return { xs: points.map((p) => p.index), ys: points.map((p) => p.value) };
  }
  if (!points.every((p) => p.value > 0)) return null;
  const lnY = points.map((p) => Math.log(p.value));
  if (family === "geometric") {
    return { xs: points.map((p) => p.index), ys: lnY };
  }
  return { xs: points.map((p) => Math.log(p.index + 1)), ys: lnY };
}

function paramsOf(family: Family, intercept: number, slope: number): RuleParams {
  if (family === "arithmetic") return { type: "arithmetic", first: r6(intercept), diff: r6(slope) };
  if (family === "geometric") {
    return { type: "geometric", first: r6(Math.exp(intercept)), ratio: r6(Math.exp(slope)) };
  }
  return { type: "power", first: r6(Math.exp(intercept)), exponent: r6(slope) };
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Theil-Sen 稳健拟合（成对斜率中位数）：对少数离群点完全稳健，作初值防 masking */
function theilSenFit(points: NumericPoint[], family: Family): RuleParams | null {
  const domain = toFitDomain(points, family);
  if (!domain) return null;
  const { xs, ys } = domain;
  const slopes: number[] = [];
  for (let a = 0; a < xs.length; a += 1) {
    for (let b = a + 1; b < xs.length; b += 1) {
      const dx = xs[b] - xs[a];
      if (dx !== 0) slopes.push((ys[b] - ys[a]) / dx);
    }
  }
  if (slopes.length === 0) return null;
  slopes.sort((m, n) => m - n);
  const slope = median(slopes);
  const intercept = median(xs.map((x, i) => ys[i] - slope * x).sort((m, n) => m - n));
  return paramsOf(family, intercept, slope);
}

/** 最小二乘拟合：初值稳健化后用于在干净点上精化参数 */
function olsFit(points: NumericPoint[], family: Family): RuleParams | null {
  const domain = toFitDomain(points, family);
  if (!domain) return null;
  const { xs, ys } = domain;
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let k = 0; k < n; k += 1) {
    sx += xs[k]; sy += ys[k]; sxx += xs[k] * xs[k]; sxy += xs[k] * ys[k];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return paramsOf(family, intercept, slope);
}

function outliersOf(points: NumericPoint[], params: RuleParams, thresholdPct: number): ColumnOutlier[] {
  const out: ColumnOutlier[] = [];
  for (const p of points) {
    const expected = expectedAtFit(params, p.index);
    const deviationPct = ((p.value - expected) / expected) * 100;
    if (Math.abs(deviationPct) > thresholdPct) {
      out.push({
        index: p.index,
        value: p.value,
        expected: Number(expected.toFixed(4)),
        deviationPct: Number(deviationPct.toFixed(2)),
      });
    }
  }
  return out;
}

function fitFamily(
  points: NumericPoint[],
  family: Family,
  thresholdPct: number,
  maxOutlierRatio: number
): RuleFit | null {
  // 初值用 Theil-Sen（离群点不拉偏）→ bad 即真实断点；占比内剔除后 OLS 精化一次
  const initial = theilSenFit(points, family);
  if (!initial) return null;
  let current = initial;
  const bad = outliersOf(points, initial, thresholdPct);
  if (bad.length > 0 && bad.length <= points.length * maxOutlierRatio && points.length - bad.length >= 3) {
    const badIdx = new Set(bad.map((o) => o.index));
    const refit = olsFit(points.filter((p) => !badIdx.has(p.index)), family);
    if (refit) {
      current = refit;
    }
  }
  const finalBad = outliersOf(points, current, thresholdPct);
  return { ...current, fitPct: Number((1 - finalBad.length / points.length).toFixed(4)) };
}

/**
 * 运行期规则推断：三族拟合并给出带置信度的最优规则 + 断点。
 * 有效数值行 <3 返回 null；best 未达立论线时为 null 但仍返回 candidates 供参考。
 */
export function inferColumnRule(values: unknown[], options?: InferOptions): InferredRule | null {
  const thresholdPct = options?.thresholdPct ?? 1;
  const maxOutlierRatio = options?.maxOutlierRatio ?? 0.2;

  const points: NumericPoint[] = [];
  let skippedRows = 0;
  values.forEach((v, i) => {
    if (typeof v === "number" && Number.isFinite(v)) points.push({ index: i, value: v });
    else skippedRows += 1;
  });
  if (points.length < 3) return null;

  const candidates = (["arithmetic", "geometric", "power"] as Family[])
    .map((f) => fitFamily(points, f, thresholdPct, maxOutlierRatio))
    .filter((f): f is RuleFit => f !== null)
    .sort((a, b) => b.fitPct - a.fitPct || FAMILY_ORDER[a.type] - FAMILY_ORDER[b.type]);

  const top = candidates[0];
  const best = top && top.fitPct >= 1 - maxOutlierRatio - 1e-9 ? top : null;
  const outliers = best ? outliersOf(points, best, thresholdPct) : [];
  return { best, candidates, outliers, validRows: points.length, skippedRows };
}

/** 规则的中文可读描述（如「等差 100 + 5×i」） */
export function ruleLabelOf(rule: RuleParams): string {
  switch (rule.type) {
    case "arithmetic":
      return `等差 ${rule.first} + ${rule.diff}×i`;
    case "geometric":
      return `等比 ${rule.first}×${rule.ratio}^i`;
    case "power":
      return `幂律 ${rule.first}×(i+1)^${rule.exponent}`;
  }
}

/* ────────────────────────────────────────────────────────────
 * 改前/改后规则对照 — compareColumnRules（写操作偏离预警）
 *
 * 改表影响评估的图谱上下文第一步：改后序列是否仍符合改前的推定规则。
 * 区分「规则变更」（apply_curve 改斜率——有意为之，提示向上传播）与
 * 「规则破坏」（乱改多行——疑似失误）；全部实时推断，无持久化。
 * ──────────────────────────────────────────────────────────── */

export interface RuleComparison {
  beforeRule: RuleFit | null;
  afterRule: RuleFit | null;
  /** 改后序列对改前规则的偏离行数（改前无规则时为 null） */
  outliersVsBefore: number | null;
  /** 相对改前自身断点的新增偏离行数（改前无规则时为 null） */
  addedBreakpoints: number | null;
  verdict:
    | "consistent" /** 同族同斜率参数且无新增断点（锚点 first 变化不算变更） */
    | "breakpoints-added" /** 规则参数未变但新增偏离断点（update_row 乱改/手调多行） */
    | "rule-change" /** 规则变更：原规则 → 新规则（apply_curve 改斜率/换族） */
    | "rule-broken" /** 原规则存在但改后无可信单一规则（乱改超立论线，疑似失误） */
    | "rule-established" /** 原无规则，改后建立规则（对乱列重设） */
    | "no-rule"; /** 两边均无可信规则，无对照基准（调用方不展示） */
  note: string;
}

/** 同族的「斜率参数」是否相等（first/锚点变化不算规则变更） */
function sameSlope(a: RuleParams, b: RuleParams): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "arithmetic" && b.type === "arithmetic") return a.diff === b.diff;
  if (a.type === "geometric" && b.type === "geometric") return a.ratio === b.ratio;
  if (a.type === "power" && b.type === "power") return a.exponent === b.exponent;
  return false;
}

export function compareColumnRules(
  before: unknown[],
  after: unknown[],
  options?: InferOptions
): RuleComparison {
  const thresholdPct = options?.thresholdPct ?? 1;
  const beforeInferred = inferColumnRule(before, options);
  const afterInferred = inferColumnRule(after, options);
  const beforeRule = beforeInferred?.best ?? null;
  const afterRule = afterInferred?.best ?? null;

  // 改后序列对改前规则的偏离行数，及相对改前自身断点的新增量
  let outliersVsBefore: number | null = null;
  let addedBreakpoints: number | null = null;
  if (beforeRule) {
    outliersVsBefore = 0;
    after.forEach((v, i) => {
      if (typeof v !== "number" || !Number.isFinite(v)) return;
      const expected = expectedAtFit(beforeRule, i);
      if (Math.abs(((v - expected) / expected) * 100) > thresholdPct) outliersVsBefore! += 1;
    });
    addedBreakpoints = outliersVsBefore - (beforeInferred?.outliers.length ?? 0);
  }

  let verdict: RuleComparison["verdict"];
  let note: string;
  if (beforeRule && afterRule) {
    if (sameSlope(beforeRule, afterRule)) {
      // first 变化 = 整列平移（对原规则必然全面偏离，是锚点语义不是断点）
      if (beforeRule.first !== afterRule.first) {
        verdict = "consistent";
        note = `规则一致（仅锚点变更）：${ruleLabelOf(beforeRule)} → first ${beforeRule.first}→${afterRule.first}（整列平移 ${afterRule.first - beforeRule.first > 0 ? "+" : ""}${afterRule.first - beforeRule.first}）`;
      } else if ((addedBreakpoints ?? 0) > 0) {
        verdict = "breakpoints-added";
        note = `规则未变（${ruleLabelOf(beforeRule)}），但新增 ${addedBreakpoints} 处偏离断点——疑似手调或误改，请确认是否有意`;
      } else {
        verdict = "consistent";
        note = `规则一致：${ruleLabelOf(beforeRule)}（改后序列仍完全符合）`;
      }
    } else {
      verdict = "rule-change";
      note = `规则变更：${ruleLabelOf(beforeRule)} → ${ruleLabelOf(afterRule)}（若为有意的曲线重设，建议同步更新相关推导）`;
    }
  } else if (beforeRule && !afterRule) {
    verdict = "rule-broken";
    note = `原推定规则 ${ruleLabelOf(beforeRule)} 在改后失效（改后无单一可信规则，${outliersVsBefore} 行偏离——疑似误改多行）`;
  } else if (!beforeRule && afterRule) {
    verdict = "rule-established";
    note = `改前无单一规则，改后建立规则：${ruleLabelOf(afterRule)}`;
  } else {
    verdict = "no-rule";
    note = "改前/改后均无可信单一规则，无对照基准";
  }
  return { beforeRule, afterRule, outliersVsBefore, addedBreakpoints, verdict, note };
}
