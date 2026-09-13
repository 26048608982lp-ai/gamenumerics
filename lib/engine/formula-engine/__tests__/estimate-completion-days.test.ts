import { describe, it, expect } from "vitest";
import { estimateProgressionCompletionDays } from "../progression";
import type { ProgressionModuleResult } from "../progression";

/** 构造线性曲线的单资源养成线（每行成本由 level_1/maxLevel 插值） */
function makeModule(
  overrides?: Partial<{
    id: string;
    resourceId: string;
    level1Cost: number;
    maxCost: number;
    maxLevel: number;
  }>
): ProgressionModuleResult {
  const resourceId = overrides?.resourceId ?? "gold";
  const maxLevel = overrides?.maxLevel ?? 2;
  return {
    id: overrides?.id ?? "m1",
    name: "模块",
    focus: "成长",
    maxLevel,
    curveType: "linear",
    contributionToAttributes: {},
    // maxLevel=2 时行成本恰为 [level1Cost, maxCost]
    resourceCostTable: Array.from({ length: maxLevel }, (_, i) => ({
      level: i + 1,
      resourceCost: {
        [resourceId]: i === 0 ? (overrides?.level1Cost ?? 100) : (overrides?.maxCost ?? 300),
      },
      attributeContribution: {},
      cumulativeCost: {},
    })),
  };
}

describe("estimateProgressionCompletionDays（growth-followups-trio Re3/c3）", () => {
  it("木桶分摊同式：单模块单资源的天数 = Σ(cost/avgBudget/share)", () => {
    const est = estimateProgressionCompletionDays(
      [makeModule()],
      { gold: [100, 500] },
      0.5,
    );
    // avgBudget=300, sharePerModule=0.5 → available=150；rows [100,300] → 100/150+300/150
    expect(est.days).toBeCloseTo(100 / 150 + 300 / 150, 6);
    expect(est.bottleneckResourceId).toBe("gold");
  });

  it("整体 = max 各线，瓶颈 = 单资源贡献最多天数者", () => {
    const lineA = makeModule({ id: "fast", resourceId: "stoneA", level1Cost: 100, maxCost: 100 });
    const lineB = makeModule({ id: "slow", resourceId: "stoneB", level1Cost: 100, maxCost: 100 });
    const est = estimateProgressionCompletionDays(
      [lineA, lineB],
      { stoneA: [200, 200], stoneB: [20, 20] },
      0.5,
    );
    // 两模块均分：split=0.5 → sharePerModule=0.25。
    // A: available=200×0.25=50 → 两行共 4 天；B: available=20×0.25=5 → 两行共 40 天
    expect(est.days).toBeCloseTo(40, 6);
    expect(est.bottleneckResourceId).toBe("stoneB");
  });

  it("split 缺省兜底 0.5；显式 split 反比影响天数", () => {
    const modules = [makeModule()];
    const byDefault = estimateProgressionCompletionDays(modules, { gold: [100, 500] });
    expect(byDefault.days).toBeCloseTo(estimateProgressionCompletionDays(modules, { gold: [100, 500] }, 0.5).days, 9);
    // share 0.25 → available 减半 → 天数翻倍
    expect(
      estimateProgressionCompletionDays(modules, { gold: [100, 500] }, 0.25).days,
    ).toBeCloseTo(byDefault.days * 2, 6);
  });

  it("除零产 0 天：日预算全零 → days=0 且无瓶颈资源键", () => {
    const est = estimateProgressionCompletionDays([makeModule()], { gold: [0, 0] }, 0.5);
    expect(est.days).toBe(0);
    expect("bottleneckResourceId" in est).toBe(false);
  });

  it("日预算未取整口径：(min+max)/2 均值参与计算而非表值取整", () => {
    // avg=(1+2)/2=1.5（非 round→2 或 floor→1）；split=1 单模块 → available=1.5；
    // 两行各 15 → days = 10+10 = 20（若误用 2 得 15，误用 1 得 30）
    const est = estimateProgressionCompletionDays(
      [makeModule({ level1Cost: 15, maxCost: 15 })],
      { gold: [1, 2] },
      1,
    );
    expect(est.days).toBeCloseTo(20, 6);
  });

  it("空模块集 / 缺失预算表 → 引擎默认档 [100,500] 与 0 天", () => {
    // 空模块：无可推演 → 0 天
    expect(estimateProgressionCompletionDays([], undefined, 0.5)).toEqual({ days: 0 });
    // 预算缺省：走 [100,500] fallback，avg=300，available=150
    const est = estimateProgressionCompletionDays([makeModule()]);
    expect(est.days).toBeCloseTo(100 / 150 + 300 / 150, 6);
  });
});

// ==================== 口径快照（followups-cleanup-stage1 Re.E1-3） ====================
// progression 共享估算为设计师期望口径：逐级行成本 ÷ 未取整 (lo+hi)/2 均值
// × consumptionSplit 分摊（非表值取整）。
// 本 describe 快照锁定口径——修改实现即失败（防静默漂移）

describe("口径快照：estimateProgressionCompletionDays（Re.E1-3）", () => {
  // 单养成线两行成本 15/15，economy 日预算 gold [1,2]（未取整均值 avg=1.5）
  const modules = [makeModule({ level1Cost: 15, maxCost: 15 })];
  const dailyBudget = { gold: [1, 2] as [number, number] };

  it("期望均值口径快照：未取整 avg 1.5 × split 分摊参与计算", () => {
    // split=1 单模块：available = 1.5 × 1 = 1.5；days = 15/1.5 + 15/1.5 = 20
    const est = estimateProgressionCompletionDays(modules, dailyBudget, 1);
    expect(est.days).toBeCloseTo(20, 9);
    expect(est.bottleneckResourceId).toBe("gold");
  });
});
