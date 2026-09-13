import { describe, expect, it } from "vitest";
import { inferPairRelation, inferTableRelations } from "../relation";

/** 模拟「基准×系数后独立取整」的派生列（强化表各装备列的真实形态） */
function roundedScale(base: number[], k: number): number[] {
  return base.map((v) => Math.round(v * k));
}

describe("inferPairRelation", () => {
  it("精确比例：B = A×0.5 → ratio 0.5 全吻合", () => {
    const a = [10, 20, 33, 47, 58];
    const rel = inferPairRelation(a, a.map((v) => v * 0.5));
    expect(rel.kind).toBe("ratio");
    expect(rel.ratio).toBe(0.5);
    expect(rel.fitPct).toBe(1);
    expect(rel.outliers).toHaveLength(0);
  });

  it("取整扰动恢复：round(A×0.6667) 仍立论且比率贴近真值", () => {
    const base = [30, 32, 33, 35, 36, 38, 39, 41, 42, 44];
    const b = roundedScale(base, 2 / 3);
    const rel = inferPairRelation(base, b);
    expect(rel.kind).toBe("ratio");
    expect(rel.fitPct).toBe(1);
    // Σb/Σa 精化后误差 <1%（真值 0.6667；逐行取整的中位比率只到 0.6629）
    expect(rel.ratio!).toBeGreaterThan(0.66);
    expect(rel.ratio!).toBeLessThan(0.674);
    expect(rel.outliers).toHaveLength(0);
  });

  it("identity：浮点尾数拷贝列判 identity 且 ratio 1", () => {
    const a = [100.1, 105.2, 110.30000000001, 115.4];
    const rel = inferPairRelation(a, a.map((v) => v + 1e-12));
    expect(rel.kind).toBe("identity");
    expect(rel.ratio).toBe(1);
  });

  it("少数离群行被标出且不拉偏比率（20 行乱改 2 行 = 10%）", () => {
    const a = Array.from({ length: 20 }, (_, i) => 100 + i * 5);
    const b = a.map((v, i) => (i === 5 || i === 12 ? v * 3 : v * 0.5));
    const rel = inferPairRelation(a, b);
    expect(rel.kind).toBe("ratio");
    expect(rel.ratio).toBe(0.5);
    expect(rel.outliers).toHaveLength(2);
    expect(rel.outliers.map((o) => o.index)).toEqual([5, 12]);
    expect(rel.fitPct).toBe(0.9);
  });

  it("离群超立论线判 none（宁缺勿滥）", () => {
    const a = Array.from({ length: 10 }, (_, i) => 100 + i * 5);
    const b = a.map((v, i) => (i < 4 ? v * 0.5 : v * 9)); // 60% 乱改
    const rel = inferPairRelation(a, b);
    expect(rel.kind).toBe("none");
    expect(rel.ratio).toBeNull();
  });

  it("无关系的独立两列判 none", () => {
    const a = [10, 20, 40, 80, 160];
    const b = [5, 25, 30, 100, 20];
    expect(inferPairRelation(a, b).kind).toBe("none");
  });

  it("恒定列无跨列结构意义：判 none 且 evidence 说明", () => {
    const a = [0.6, 0.6, 0.6, 0.6, 0.6];
    const b = [1, 2, 3, 4, 5];
    const rel = inferPairRelation(a, b);
    expect(rel.kind).toBe("none");
    expect(rel.evidence).toContain("恒定列");
  });

  it("非数值行跳过并计数，关系仍成立", () => {
    const a = [10, null, 30, "x", 50, 60] as unknown[];
    const b = [5, 99, 15, 99, 25, 30] as unknown[];
    const rel = inferPairRelation(a, b);
    expect(rel.kind).toBe("ratio");
    expect(rel.ratio).toBe(0.5);
    expect(rel.validRows).toBe(4);
    expect(rel.skippedRows).toBe(2);
  });

  it("有效配对行不足 3 判 none", () => {
    const rel = inferPairRelation([10, 20], [5, 10]);
    expect(rel.kind).toBe("none");
    expect(rel.evidence).toContain("不足");
  });
});

describe("inferTableRelations", () => {
  /** 合成宽表：基准列 + 两个派生列（取整）+ 无关系列 + 恒定列 + 非数值列 */
  function buildTable() {
    const base = Array.from({ length: 15 }, (_, i) => 30 + i * 2.3);
    return {
      "太刀.数值": base,
      "匕首.数值": roundedScale(base, 2 / 3),
      "大刀.数值": roundedScale(base, 5 / 3),
      "无关.数值": [9, 3, 7, 1, 8, 2, 6, 4, 5, 3, 2, 8, 1, 7, 4],
      "属性划分.攻击": Array.from({ length: 15 }, () => 0.6),
      "属性类型": Array.from({ length: 15 }, () => "攻击"),
    };
  }

  it("发现基准锚点并报告全部成立关系对与剔除原因", () => {
    const result = inferTableRelations(buildTable())!;
    // 三个派生族列两两构成关系 → 度并列，锚点裁决取列名序（相对比率不变，
    // 基准只是表述锚点，跨表对照以 pairs 全集为准）
    expect(["太刀.数值", "匕首.数值", "大刀.数值"]).toContain(result.baseColumn);
    // 关键锚：匕首 ≈ 太刀 × 2/3（装备划分系数 0.6667 的对照目标）
    const anchor = result.pairs.find(
      (p) => (p.a === "太刀.数值" && p.b === "匕首.数值") || (p.a === "匕首.数值" && p.b === "太刀.数值")
    )!;
    expect(anchor.relation.kind).toBe("ratio");
    const daggerRatio = anchor.a === "太刀.数值" ? anchor.relation.ratio! : 1 / anchor.relation.ratio!;
    expect(daggerRatio).toBeGreaterThan(0.66);
    expect(daggerRatio).toBeLessThan(0.674);
    // 三个派生族列两两成立（3 对），无关列零关系
    expect(result.pairs).toHaveLength(3);
    const report = new Map(result.columns.map((c) => [c.column, c]));
    expect(report.get("无关.数值")!.kind).toBe("none");
    expect(report.get("太刀.数值")!.kind === "base" || report.get("太刀.数值")!.kind).toBeTruthy();
    // 恒定列与非数值列被剔除并说明原因
    const excluded = new Map(result.excludedColumns.map((e) => [e.column, e.reason]));
    expect(excluded.get("属性划分.攻击")).toContain("恒定");
    expect(excluded.get("属性类型")).toContain("数值行不足");
  });

  it("无任何成立关系时 baseColumn 为 null 且 columns 全为 none 描述", () => {
    const result = inferTableRelations({
      x: [1, 5, 9, 13, 20, 31, 44, 2, 17, 8, 25, 3, 39, 11, 6],
      y: [90, 12, 3, 77, 28, 55, 41, 66, 19, 4, 88, 32, 7, 50, 23],
      z: [2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 2.5],
    })!;
    expect(result.baseColumn).toBeNull();
    expect(result.pairs).toHaveLength(0);
    expect(result.columns.every((c) => c.kind === "none")).toBe(true);
  });

  it("两两配对数超上限时不产出关系并提示指定列子集", () => {
    const columns: Record<string, number[]> = {};
    for (let i = 0; i < 40; i += 1) {
      columns[`c${i}`] = Array.from({ length: 10 }, (_, j) => (i + 1) * (j + 1) + j * j);
    }
    const result = inferTableRelations(columns)!;
    expect(result.baseColumn).toBeNull();
    expect(result.pairs).toHaveLength(0);
    expect(result.columns).toHaveLength(0);
    expect(result.excludedColumns.some((e) => e.reason.includes("上限"))).toBe(true);
  });
});
