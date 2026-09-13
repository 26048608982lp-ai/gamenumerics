import { describe, it, expect } from "vitest";
import { detectColumnPattern, detectOutliers, expectedAt } from "../pattern";

describe("detectColumnPattern — 从值序列反推生成规则", () => {
  it("等差：导表-英雄攻击形态（100,105,110,114.99…，浮点尾数不干扰）", () => {
    const p = detectColumnPattern([100, 105, 110.0000000000, 114.9999999999, 120]);
    expect(p).toEqual({ type: "arithmetic", first: 100, diff: 5 });
  });

  it("等比：比值恒定", () => {
    const p = detectColumnPattern([100, 105, 110.25, 115.7625]);
    expect(p).toEqual({ type: "geometric", first: 100, ratio: 1.05 });
  });

  it("常数列", () => {
    expect(detectColumnPattern([1.3, 1.3, 1.3, 1.3])).toEqual({ type: "constant", value: 1.3 });
  });

  it("无规律 / 含非数值 / 不足 3 个 → null", () => {
    expect(detectColumnPattern([1, 3, 2, 7])).toBeNull();
    expect(detectColumnPattern([1, "x", 3])).toBeNull();
    expect(detectColumnPattern([1, 2])).toBeNull();
  });

  it("负公差等差可识别", () => {
    expect(detectColumnPattern([10, 8, 6, 4])).toEqual({ type: "arithmetic", first: 10, diff: -2 });
  });
});

describe("detectOutliers — 偏离生成规则的断点审计", () => {
  it("等比列中段手调点被报告（偏离%与期望值）", () => {
    const values = [100, 105, 110.25, 130, 121.55]; // index 3 期望 115.76，实际 130
    const p = detectColumnPattern(values.slice(0, 3).concat([115.7625, 121.550625]));
    expect(p?.type).toBe("geometric");
    const outliers = detectOutliers(values, p!);
    expect(outliers).toHaveLength(1);
    expect(outliers[0].index).toBe(3);
    expect(outliers[0].deviationPct).toBeGreaterThan(12);
    expect(outliers[0].deviationPct).toBeLessThan(13);
  });

  it("容差内（<1%）不报告", () => {
    const p = detectColumnPattern([100, 105, 110.25, 115.7625])!;
    const values = [100, 105, 110.25, 115.9];
    expect(detectOutliers(values, p)).toHaveLength(0);
  });
});

describe("expectedAt", () => {
  it("三模式生成第 i 值（0 起）", () => {
    expect(expectedAt({ type: "constant", value: 7 }, 5)).toBe(7);
    expect(expectedAt({ type: "arithmetic", first: 100, diff: 5 }, 3)).toBe(115);
    expect(expectedAt({ type: "geometric", first: 100, ratio: 1.05 }, 2)).toBeCloseTo(110.25, 6);
  });
});
