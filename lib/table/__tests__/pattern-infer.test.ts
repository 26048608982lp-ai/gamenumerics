import { describe, it, expect } from "vitest";
import { inferColumnRule, expectedAtFit, compareColumnRules, ruleLabelOf, type RuleParams } from "../pattern";

/** 构造等差序列：v(i) = first + diff·i（i 即行号） */
const arith = (n: number, first: number, diff: number) =>
  Array.from({ length: n }, (_, i) => first + diff * i);
/** 构造等比序列：v(i) = first·ratio^i */
const geo = (n: number, first: number, ratio: number) =>
  Array.from({ length: n }, (_, i) => Number((first * Math.pow(ratio, i)).toFixed(6)));
/** 构造幂律序列：v(i) = first·(i+1)^k */
const pow = (n: number, first: number, k: number) =>
  Array.from({ length: n }, (_, i) => Number((first * Math.pow(i + 1, k)).toFixed(6)));

describe("inferColumnRule — 三大曲线族推断", () => {
  it("纯等差：best=arithmetic，参数精确恢复，无断点", () => {
    const r = inferColumnRule(arith(100, 100, 5))!;
    expect(r.best).toEqual({ type: "arithmetic", first: 100, diff: 5, fitPct: 1 });
    expect(r.outliers).toEqual([]);
    expect(r.validRows).toBe(100);
    expect(r.skippedRows).toBe(0);
  });

  it("纯等比：log 域拟合恢复 ratio", () => {
    const r = inferColumnRule(geo(60, 100, 1.05))!;
    expect(r.best).toEqual({ type: "geometric", first: 100, ratio: 1.05, fitPct: 1 });
    expect(r.outliers).toEqual([]);
  });

  it("幂律：log-log 域拟合恢复 exponent", () => {
    const r = inferColumnRule(pow(80, 100, 1.5))!;
    expect(r.best).toEqual({ type: "power", first: 100, exponent: 1.5, fitPct: 1 });
  });

  it("常数列由等比/幂律退化覆盖（diff=0 即常数）", () => {
    const r = inferColumnRule([1.3, 1.3, 1.3, 1.3, 1.3])!;
    expect(r.best?.type).toBe("arithmetic");
    expect(r.best).toMatchObject({ first: 1.3, diff: 0 });
  });
});

describe("inferColumnRule — 手调断点（Theil-Sen 防 masking）", () => {
  it("等差 100 行中 5 行手调 +500：断点恰好全被标出，规则仍立论", () => {
    const values = arith(100, 100, 5);
    for (const i of [40, 41, 42, 43, 44]) values[i] += 500;
    const r = inferColumnRule(values)!;
    expect(r.best).toEqual({ type: "arithmetic", first: 100, diff: 5, fitPct: 0.95 });
    expect(r.outliers.map((o) => o.index)).toEqual([40, 41, 42, 43, 44]);
  });

  it("等比序列尾部 3 行手调：断点标出且 ratio 不被拉偏", () => {
    const values = geo(50, 100, 1.08);
    for (const i of [47, 48, 49]) values[i] *= 2;
    const r = inferColumnRule(values)!;
    expect(r.best).toEqual({ type: "geometric", first: 100, ratio: 1.08, fitPct: 0.94 });
    expect(r.outliers.map((o) => o.index)).toEqual([47, 48, 49]);
  });
});

describe("inferColumnRule — 不立论与边界", () => {
  it("无规律序列：best=null（宁缺勿编），candidates 仍供参考", () => {
    const r = inferColumnRule([100, 999, 3, 777, 42, 88, 1, 500, 260, 33])!;
    expect(r.best).toBeNull();
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.outliers).toEqual([]);
  });

  it("分段等差（前半 diff5 后半 diff10）：非单一规则不立论", () => {
    const values = [...arith(50, 100, 5), ...Array.from({ length: 50 }, (_, i) => 100 + 5 * 49 + 10 * (i + 1))];
    const r = inferColumnRule(values)!;
    expect(r.best).toBeNull();
  });

  it("各族全吻合的短序列：同分简单族优先（等差 > 等比 > 幂律）", () => {
    const r = inferColumnRule([100, 105, 110])!;
    expect(r.best?.type).toBe("arithmetic");
    expect(r.best?.fitPct).toBe(1);
  });

  it("非数值行跳过且不扭曲规则（x 用原行号）", () => {
    const values: unknown[] = [100, "x", 110, "y", 120, null];
    const r = inferColumnRule(values)!;
    expect(r.validRows).toBe(3);
    expect(r.skippedRows).toBe(3);
    expect(r.best).toEqual({ type: "arithmetic", first: 100, diff: 5, fitPct: 1 });
  });

  it("有效数值行不足 3：返回 null", () => {
    expect(inferColumnRule([100, 105])).toBeNull();
    expect(inferColumnRule(["a", "b"])).toBeNull();
    expect(inferColumnRule([])).toBeNull();
  });
});

describe("expectedAtFit — 按拟合参数生成期望值", () => {
  it("三族第 i 行期望（i 为原行号）", () => {
    const a: RuleParams = { type: "arithmetic", first: 100, diff: 5 };
    expect(expectedAtFit(a, 3)).toBe(115);
    const g: RuleParams = { type: "geometric", first: 100, ratio: 1.05 };
    expect(expectedAtFit(g, 2)).toBeCloseTo(110.25, 6);
    const p: RuleParams = { type: "power", first: 100, exponent: 1.5 };
    expect(expectedAtFit(p, 3)).toBeCloseTo(100 * 4 ** 1.5, 6);
  });
});

describe("compareColumnRules — 改前/改后规则对照（写操作偏离预警）", () => {
  it("apply_curve 改斜率（diff 5→6）：判「规则变更」并给出新旧规则", () => {
    const before = arith(50, 100, 5);
    const after = arith(50, 100, 6);
    const c = compareColumnRules(before, after);
    expect(c.verdict).toBe("rule-change");
    expect(c.beforeRule).toMatchObject({ type: "arithmetic", diff: 5 });
    expect(c.afterRule).toMatchObject({ type: "arithmetic", diff: 6 });
    // i 行对原规则偏差 = i/(100+5i)%：i=0 无偏差、i=1 为 1/105≈0.95%（容差内），i≥2 超阈值 → 50-2=48
    expect(c.outliersVsBefore).toBe(48);
    expect(c.note).toContain("规则变更");
    expect(c.note).toContain("等差 100 + 5×i");
  });

  it("沿规则平移（改 first 不改 diff）：判「规则一致·仅锚点变更」", () => {
    const before = arith(50, 100, 5);
    const after = arith(50, 120, 5);
    const c = compareColumnRules(before, after);
    expect(c.verdict).toBe("consistent");
    expect(c.note).toContain("仅锚点变更");
    expect(c.note).toContain("100→120");
  });

  it("update_row 乱改多行：规则未变但新增断点（Theil-Sen 仍恢复原规则）", () => {
    const before = arith(50, 100, 5);
    const after = [...before];
    for (const i of [10, 20, 30, 40]) after[i] += 500 + i * 13; // 无规律乱改
    const c = compareColumnRules(before, after);
    expect(c.verdict).toBe("breakpoints-added");
    expect(c.afterRule).toMatchObject({ type: "arithmetic", diff: 5 }); // 主体规则仍被恢复
    expect(c.addedBreakpoints).toBe(4);
    expect(c.note).toContain("新增 4 处");
  });

  it("对无规律列 apply_curve 重设：判「建立规则」", () => {
    const before = [100, 999, 3, 777, 42, 88, 1, 500, 260, 33];
    const after = arith(10, 100, 5);
    const c = compareColumnRules(before, after);
    expect(c.verdict).toBe("rule-established");
    expect(c.note).toContain("改后建立规则");
  });

  it("两边均无规律：no-rule（调用方不展示）", () => {
    const c = compareColumnRules([1, 9, 2, 8, 3], [7, 1, 6, 2, 9]);
    expect(c.verdict).toBe("no-rule");
  });

  it("完全相同的序列：规则一致", () => {
    const c = compareColumnRules(arith(20, 100, 5), arith(20, 100, 5));
    expect(c.verdict).toBe("consistent");
    expect(c.note).toContain("完全符合");
    expect(c.outliersVsBefore).toBe(0);
  });
});

describe("ruleLabelOf — 规则中文标签", () => {
  it("三族标签", () => {
    expect(ruleLabelOf({ type: "arithmetic", first: 100, diff: 5 })).toBe("等差 100 + 5×i");
    expect(ruleLabelOf({ type: "geometric", first: 100, ratio: 1.08 })).toBe("等比 100×1.08^i");
    expect(ruleLabelOf({ type: "power", first: 100, exponent: 1.5 })).toBe("幂律 100×(i+1)^1.5");
  });
});
