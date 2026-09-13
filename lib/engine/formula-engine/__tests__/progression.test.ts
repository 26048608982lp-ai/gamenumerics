import { describe, it, expect } from "vitest";
import {
  computeProgressionFromIntent,
  computeTimeBudget,
  overallDaysAcrossLines,
  type ProgressionModuleResult,
} from "../progression";
import type { KeyMilestone, ProgressionDesignIntent } from "../types";

function makeProgressionIntent(overrides?: Partial<ProgressionDesignIntent>): ProgressionDesignIntent {
  return {
    moduleType: "progression",
    decisions: {
      progressionDepth: "moderate",
      moduleCount: 2,
      coreProgressionAxis: "level",
      rationale: "Two-axis progression",
    },
    strategy: {
      modules: [
        {
          id: "weapon",
          name: "武器强化",
          focus: "ATK",
          curveType: "linear",
          maxLevel: 10,
          contributionToAttributes: { ATK: 1000 },
          level_1_cost: { gold: 100 },
          maxLevel_cost: { gold: 10000 },
        },
        {
          id: "armor",
          name: "防具强化",
          focus: "DEF",
          curveType: "exponential",
          maxLevel: 20,
          contributionToAttributes: { DEF: 800, HP: 2000 },
          level_1_cost: { gold: 50, gem: 1 },
          maxLevel_cost: { gold: 5000, gem: 100 },
        },
      ],
    },
    anchors: { totalMaxLevel: 30 },
    ...overrides,
  };
}

describe("computeProgressionFromIntent", () => {
  it("generates module results for each module", () => {
    const result = computeProgressionFromIntent(makeProgressionIntent());
    expect(result.progressionModules.length).toBe(2);
  });

  it("generates correct number of levels per module", () => {
    const result = computeProgressionFromIntent(makeProgressionIntent());
    expect(result.progressionModules[0].resourceCostTable.length).toBe(10);
    expect(result.progressionModules[1].resourceCostTable.length).toBe(20);
  });

  it("first level cost matches level_1_cost", () => {
    const result = computeProgressionFromIntent(makeProgressionIntent());
    expect(result.progressionModules[0].resourceCostTable[0].resourceCost.gold).toBe(100);
  });

  it("last level cost matches maxLevel_cost", () => {
    const result = computeProgressionFromIntent(makeProgressionIntent());
    const lastRow = result.progressionModules[0].resourceCostTable[9];
    expect(lastRow.resourceCost.gold).toBe(10000);
  });

  // ---------------------------------------------------------------------
  // progression-P2a 引擎侧并集兜底：资源键集 = level_1_cost ∪ maxLevel_cost。
  // schema 层已拒绝键集不一致（交由自修复），此处兜底防御旧数据/绕过路径——
  // 单侧独有键不再被静默丢弃（旧行为只扫 level_1_cost 键）
  // ---------------------------------------------------------------------
  describe("resource key union (progression-P2a)", () => {
    it("maxLevel_cost 独有键进入消耗表（缺失侧走默认锚 10/1000）", () => {
      const base = makeProgressionIntent();
      const result = computeProgressionFromIntent({
        ...base,
        strategy: {
          modules: [
            {
              ...base.strategy.modules[0],
              level_1_cost: { gold: 100 },            // 无 shard
              maxLevel_cost: { gold: 10000, shard: 500 }, // shard 独有
            },
          ],
        },
      });
      const table = result.progressionModules[0].resourceCostTable;
      // 修复前：resourceIds 只扫 level_1_cost → shard 行级成本被整体丢弃
      expect(table[0].resourceCost.shard).toBe(10); // level_1 缺键 → 默认起点 10
      expect(table[9].resourceCost.shard).toBe(500); // maxLevel 声明值
      expect(table[0].resourceCost.gold).toBe(100);
      expect(table[9].resourceCost.gold).toBe(10000);
    });

    it("level_1_cost 独有键进入消耗表（maxLevel 侧缺键 → 默认终点 1000）", () => {
      const base = makeProgressionIntent();
      const result = computeProgressionFromIntent({
        ...base,
        strategy: {
          modules: [
            {
              ...base.strategy.modules[0],
              level_1_cost: { gold: 100, gem: 1 }, // gem 独有
              maxLevel_cost: { gold: 10000 },
            },
          ],
        },
      });
      const table = result.progressionModules[0].resourceCostTable;
      expect(table[0].resourceCost.gem).toBe(1);
      expect(table[9].resourceCost.gem).toBe(1000); // maxLevel 缺键 → 默认终点 1000
    });

    it("cumulativeCost 覆盖并集键（shard 全程累计）", () => {
      const base = makeProgressionIntent();
      const result = computeProgressionFromIntent({
        ...base,
        strategy: {
          modules: [
            {
              ...base.strategy.modules[0],
              level_1_cost: { gold: 100 },
              maxLevel_cost: { gold: 10000, shard: 500 },
            },
          ],
        },
      });
      const lastRow = result.progressionModules[0].resourceCostTable[9];
      expect(lastRow.cumulativeCost.shard).toBeGreaterThanOrEqual(500);
      expect(lastRow.cumulativeCost.gold).toBeGreaterThanOrEqual(10000);
    });
  });

  it("cumulative cost increases monotonically", () => {
    const result = computeProgressionFromIntent(makeProgressionIntent());
    const table = result.progressionModules[0].resourceCostTable;
    for (let i = 1; i < table.length; i++) {
      expect(table[i].cumulativeCost.gold).toBeGreaterThanOrEqual(table[i - 1].cumulativeCost.gold);
    }
  });

  it("attribute contribution sums correctly at max level", () => {
    const result = computeProgressionFromIntent(makeProgressionIntent());
    const lastRow = result.progressionModules[0].resourceCostTable[9];
    expect(lastRow.attributeContribution!.ATK).toBe(1000);
  });

  it("total attribute contribution aggregates all modules", () => {
    const result = computeProgressionFromIntent(makeProgressionIntent());
    expect(result.totalAttributeContribution.ATK).toBe(1000);
    expect(result.totalAttributeContribution.DEF).toBe(800);
    expect(result.totalAttributeContribution.HP).toBe(2000);
  });

  it("all resource costs are positive", () => {
    const result = computeProgressionFromIntent(makeProgressionIntent());
    for (const mod of result.progressionModules) {
      for (const row of mod.resourceCostTable) {
        for (const val of Object.values(row.resourceCost)) {
          expect(val).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  // ── 档位差异（planning-four-expectation R3：恒有落盘 + 透传 + 畸形整档回退） ──
  describe("tierDifferentiation (R3)", () => {
    const DEFAULT_TIER = {
      tierCount: 3,
      attributeMultipliers: [1, 2, 4],
      costMultipliers: [1, 1.5, 2.5],
    };

    function intentWithTier(tier: ProgressionDesignIntent["decisions"]["tierDifferentiation"]): ProgressionDesignIntent {
      const base = makeProgressionIntent();
      return {
        ...base,
        decisions: { ...base.decisions, tierDifferentiation: tier },
      };
    }

    it("缺省落盘：intent 不带字段 → computed 恒有缺省档", () => {
      const result = computeProgressionFromIntent(makeProgressionIntent());
      expect(result.tierDifferentiation).toEqual(DEFAULT_TIER);
    });

    it("透传：合法档位（两数组长度 === tierCount、首元素 1）→ 原值输出", () => {
      const tier = {
        tierCount: 4,
        attributeMultipliers: [1, 1.8, 3.2, 6],
        costMultipliers: [1, 1.4, 2, 3.6],
      };
      const result = computeProgressionFromIntent(intentWithTier(tier));
      expect(result.tierDifferentiation).toEqual(tier);
    });

    it("畸形回退：tierCount=4 但数组长度 3 → 整档回退缺省（不部分采纳畸形输入）", () => {
      const result = computeProgressionFromIntent(
        intentWithTier({
          tierCount: 4,
          attributeMultipliers: [1, 2, 4],
          costMultipliers: [1, 1.5, 2.5],
        })
      );
      expect(result.tierDifferentiation).toEqual(DEFAULT_TIER);
    });

    it("畸形回退：tierCount<2 或 ≥9 → 整档回退缺省", () => {
      expect(
        computeProgressionFromIntent(
          intentWithTier({ tierCount: 1, attributeMultipliers: [1], costMultipliers: [1] })
        ).tierDifferentiation
      ).toEqual(DEFAULT_TIER);
      expect(
        computeProgressionFromIntent(
          intentWithTier({
            tierCount: 9,
            attributeMultipliers: [1, 2, 3, 4, 5, 6, 7, 8, 9],
            costMultipliers: [1, 2, 3, 4, 5, 6, 7, 8, 9],
          })
        ).tierDifferentiation
      ).toEqual(DEFAULT_TIER);
    });

    it("畸形回退：数组首元素 ≠ 1 → 整档回退缺省", () => {
      expect(
        computeProgressionFromIntent(
          intentWithTier({
            tierCount: 3,
            attributeMultipliers: [0.5, 2, 4],
            costMultipliers: [1, 1.5, 2.5],
          })
        ).tierDifferentiation
      ).toEqual(DEFAULT_TIER);
      expect(
        computeProgressionFromIntent(
          intentWithTier({
            tierCount: 3,
            attributeMultipliers: [1, 2, 4],
            costMultipliers: [1.2, 1.5, 2.5],
          })
        ).tierDifferentiation
      ).toEqual(DEFAULT_TIER);
    });
  });
});

describe("computeTimeBudget", () => {
  const economyBudget: Record<string, [number, number]> = { gold: [200, 800], gem: [10, 50] };

  function makeTimeBudgetModules() {
    const result = computeProgressionFromIntent(makeProgressionIntent());
    return computeTimeBudget(result.progressionModules, economyBudget, 0.4);
  }

  it("speedComparison has non-zero values with valid economy data", () => {
    const budget = makeTimeBudgetModules();
    for (const phase of budget.speedComparison) {
      expect(phase.casualDaysPerLevel).toBeGreaterThan(0);
      expect(phase.averageDaysPerLevel).toBeGreaterThan(0);
      expect(phase.hardcoreDaysPerLevel).toBeGreaterThan(0);
    }
  });

  it("speedComparison is monotonically increasing: early < mid < late", () => {
    const budget = makeTimeBudgetModules();
    const [early, mid, late] = budget.speedComparison;
    expect(early.averageDaysPerLevel).toBeLessThan(mid.averageDaysPerLevel);
    expect(mid.averageDaysPerLevel).toBeLessThan(late.averageDaysPerLevel);
  });

  it("within each phase, casual > average > hardcore (休闲最慢, 硬核最快)", () => {
    const budget = makeTimeBudgetModules();
    for (const phase of budget.speedComparison) {
      expect(phase.casualDaysPerLevel).toBeGreaterThan(phase.averageDaysPerLevel);
      expect(phase.averageDaysPerLevel).toBeGreaterThan(phase.hardcoreDaysPerLevel);
    }
  });

  it("cumulativeDays monotonically increasing per module", () => {
    const budget = makeTimeBudgetModules();
    for (const mod of budget.modules) {
      for (let i = 1; i < mod.levelTable.length; i++) {
        const prev = mod.levelTable[i - 1].cumulativeDays;
        const curr = mod.levelTable[i].cumulativeDays;
        expect(curr.casual).toBeGreaterThanOrEqual(prev.casual);
        expect(curr.average).toBeGreaterThanOrEqual(prev.average);
        expect(curr.hardcore).toBeGreaterThanOrEqual(prev.hardcore);
      }
    }
  });

  it("totalDays: casual > average > hardcore for each module", () => {
    const budget = makeTimeBudgetModules();
    for (const mod of budget.modules) {
      expect(mod.totalDays.casual).toBeGreaterThan(mod.totalDays.average);
      expect(mod.totalDays.average).toBeGreaterThan(mod.totalDays.hardcore);
    }
  });

  it("produces valid results with default economy (no budget provided)", () => {
    const result = computeProgressionFromIntent(makeProgressionIntent());
    const budget = computeTimeBudget(result.progressionModules);
    expect(budget.modules.length).toBe(2);
    for (const phase of budget.speedComparison) {
      expect(phase.casualDaysPerLevel).toBeGreaterThan(0);
      expect(phase.averageDaysPerLevel).toBeGreaterThan(0);
      expect(phase.hardcoreDaysPerLevel).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------
  // 行级守卫（Follow-ups P2 #5）：畸形 DB 存量行（resourceCost null/缺失）
  // 不抛 TypeError，坏行 continue 跳过、好行天数不受牵连
  //（守卫单源复用 estimateProgressionCompletionDays 同款 isValidResourceCostRow）
  // ---------------------------------------------------------------------
  describe("行级守卫（P2 #5）", () => {
    const budget: Record<string, [number, number]> = { gold: [200, 800] };

    function makeModules(rows: unknown[]) {
      return [
        {
          id: "m1",
          name: "武器强化",
          focus: "ATK",
          maxLevel: rows.length,
          curveType: "linear",
          contributionToAttributes: {},
          resourceCostTable: rows,
        },
      ] as unknown as Parameters<typeof computeTimeBudget>[0];
    }

    it("resourceCost=null 畸形行跳过不抛 TypeError，好行结果与剔除坏行的干净输入一致", () => {
      const goodRow = { level: 1, resourceCost: { gold: 100 }, attributeContribution: {}, cumulativeCost: {} };
      const badRow = { level: 2, resourceCost: null, attributeContribution: {}, cumulativeCost: {} };

      expect(() => computeTimeBudget(makeModules([goodRow, badRow]), budget, 1)).not.toThrow();

      const withBad = computeTimeBudget(makeModules([goodRow, badRow]), budget, 1);
      const clean = computeTimeBudget(makeModules([goodRow]), budget, 1);
      expect(withBad.modules[0].totalDays).toEqual(clean.modules[0].totalDays);
      expect(withBad.modules[0].levelTable).toHaveLength(1);
    });

    it("resourceCost 键完全缺失的畸形行同款跳过（null/缺失 双形态），结果与干净输入全等", () => {
      const goodRow = { level: 1, resourceCost: { gold: 100 }, attributeContribution: {}, cumulativeCost: {} };
      const badRow = { level: 2, attributeContribution: {}, cumulativeCost: {} }; // 无 resourceCost 键

      // 模块级元数据（maxLevel 等）两边固定一致、不随 rows.length 派生，隔离「坏行是否被跳过」单一变量
      const makeFixedModules = (rows: unknown[]) =>
        [
          {
            id: "m1",
            name: "武器强化",
            focus: "ATK",
            maxLevel: 2,
            curveType: "linear",
            contributionToAttributes: {},
            resourceCostTable: rows,
          },
        ] as unknown as Parameters<typeof computeTimeBudget>[0];

      expect(() => computeTimeBudget(makeFixedModules([goodRow, badRow]), budget, 1)).not.toThrow();

      const withBad = computeTimeBudget(makeFixedModules([goodRow, badRow]), budget, 1);
      const clean = computeTimeBudget(makeFixedModules([goodRow]), budget, 1);
      expect(withBad.modules[0]).toEqual(clean.modules[0]);
    });
  });
});

// ==================== 整体满级天数聚合单源（Follow-ups P2 #7） ====================

describe("overallDaysAcrossLines（P2 #7 聚合单源）", () => {
  it("空数组返回 0（对齐引擎 estimate 现状 overallDays 初始 0）", () => {
    expect(overallDaysAcrossLines([])).toBe(0);
  });

  it("多线取最大值（整体满级 = max over lines 口径）", () => {
    expect(overallDaysAcrossLines([4, 40, 12])).toBe(40);
  });

  it("单线透传该线总天数（含小数不取整）", () => {
    expect(overallDaysAcrossLines([7.5])).toBe(7.5);
  });
});

// ==================== F1：关键养成节点（keyMilestones，Spec v6w1 §5 progression ①-⑦） ====================

describe("computeProgressionFromIntent — keyMilestones", () => {
  it("① keyMilestones 透传 + missingResources 命中/不命中", () => {
    const keyMilestones: KeyMilestone[] = [
      {
        id: "star_5",
        type: "star",
        label: "5星",
        target: 5,
        unlockDescription: "解锁特殊技能",
        duplicateCount: 4,
        costResources: { gold: 1000, gem: 10 },
      },
      {
        id: "bt_1",
        type: "breakthrough",
        target: 1,
        costResources: { soul_stone: 5 },
      },
    ];
    const result = computeProgressionFromIntent(
      makeProgressionIntent({ keyMilestones })
    );

    // intent 资源键并集 = {gold, gem}（weapon: gold；armor: gold+gem）
    expect(result.keyMilestones).toHaveLength(2);
    expect(result.keyMilestones![0]).toMatchObject({
      id: "star_5",
      type: "star",
      target: 5,
      duplicateCount: 4,
      costResources: { gold: 1000, gem: 10 },
      missingResources: [],
    });
    expect(result.keyMilestones![1].missingResources).toEqual(["soul_stone"]);
  });

  it("② 无 keyMilestones 时返回不含该键（向后兼容）", () => {
    const result = computeProgressionFromIntent(makeProgressionIntent());
    expect("keyMilestones" in result).toBe(false);
    expect(result.keyMilestones).toBeUndefined();
  });
});

describe("computeTimeBudget — keyMilestoneTimeline", () => {
  const economyBudget: Record<string, [number, number]> = { gold: [200, 800], gem: [10, 50] };
  const split = 0.4; // 两个 module → sharePerModule = 0.2

  /** 单 module 恒定消耗意图：每级 gold 100，maxLevel 10 */
  function makeSingleModuleIntent(): ProgressionDesignIntent {
    return makeProgressionIntent({
      decisions: {
        progressionDepth: "light",
        moduleCount: 1,
        coreProgressionAxis: "level",
        rationale: "single module",
      },
      strategy: {
        modules: [
          {
            id: "level_line",
            name: "等级线",
            focus: "ATK",
            curveType: "linear",
            maxLevel: 10,
            contributionToAttributes: { ATK: 100 },
            level_1_cost: { gold: 100 },
            maxLevel_cost: { gold: 100 },
          },
        ],
      },
    });
  }

  /** 单 module + budget [100,100] + share 1：每级 1 天，cumulativeDays@N = N（三档同） */
  function makeSingleModuleTimeline(milestones: KeyMilestone[]) {
    const result = computeProgressionFromIntent(makeSingleModuleIntent());
    return computeTimeBudget(result.progressionModules, { gold: [100, 100] }, 1, milestones);
  }

  it("③ star 型节点天数手算断言（木桶 max + 分摊 0.2）", () => {
    const result = computeProgressionFromIntent(makeProgressionIntent());
    const milestones: KeyMilestone[] = [
      { id: "star_3", type: "star", target: 3, costResources: { gold: 2000, gem: 60 } },
    ];
    const budget = computeTimeBudget(
      result.progressionModules,
      economyBudget,
      split,
      milestones
    );

    const node = budget.keyMilestoneTimeline![0];
    expect(node.id).toBe("star_3");
    expect(node.type).toBe("star");
    expect(node.target).toBe(3);
    expect(node.resourceCost).toEqual({ gold: 2000, gem: 60 });
    // gold: 2000/(200*0.2)=50, 2000/(500*0.2)=20, 2000/(800*0.2)=12.5
    // gem:  60/(10*0.2)=30, 60/(30*0.2)=10, 60/(50*0.2)=6 → 木桶取 max
    expect(node.days.casual).toBe(50);
    expect(node.days.average).toBe(20);
    expect(node.days.hardcore).toBe(12.5);
  });

  it("③b unlock/breakthrough 型节点按 intent 顺序透传", () => {
    const result = computeProgressionFromIntent(makeProgressionIntent());
    const milestones: KeyMilestone[] = [
      { id: "unlock_2", type: "unlock", target: 2, costResources: { gold: 400 } },
      { id: "bt_1", type: "breakthrough", target: 1, costResources: { gem: 10 } },
    ];
    const budget = computeTimeBudget(
      result.progressionModules,
      economyBudget,
      split,
      milestones
    );

    expect(budget.keyMilestoneTimeline!.map((n) => n.id)).toEqual(["unlock_2", "bt_1"]);
    // unlock_2: 400/(200*0.2)=10, 400/(500*0.2)=4, 400/(800*0.2)=2.5
    expect(budget.keyMilestoneTimeline![0].days).toEqual({ casual: 10, average: 4, hardcore: 2.5 });
    // bt_1: 10/(10*0.2)=5, 10/(30*0.2)=1.67, 10/(50*0.2)=1
    expect(budget.keyMilestoneTimeline![1].days.casual).toBe(5);
    expect(budget.keyMilestoneTimeline![1].days.average).toBeCloseTo(1.67, 2);
    expect(budget.keyMilestoneTimeline![1].days.hardcore).toBe(1);
  });

  it("④ level 型节点对齐 cumulativeDays 并与材料瓶颈取 max", () => {
    // 单 module 恒定消耗：每级 gold 100，budget [100,100]，share=1 → 每级 1 天，cum@5 = 5
    const budget = makeSingleModuleTimeline([
      // 材料瓶颈 = 200/100 = 2 < cumulativeDays@5 = 5 → 取 5
      { id: "level_5", type: "level", target: 5, relatedModuleId: "level_line", costResources: { gold: 200 } },
      // 材料瓶颈 = 1000/100 = 10 > cumulativeDays@5 = 5 → 取 10
      { id: "level_5_exp", type: "level", target: 5, relatedModuleId: "level_line", costResources: { gold: 1000 } },
    ]);

    const [node, nodeExp] = budget.keyMilestoneTimeline!;
    expect(node.days).toEqual({ casual: 5, average: 5, hardcore: 5 });
    expect(nodeExp.days).toEqual({ casual: 10, average: 10, hardcore: 10 });
  });

  it("⑤ 无 economyDailyBudget 时沿用 [100,500] fallback 预算", () => {
    const result = computeProgressionFromIntent(makeProgressionIntent());
    const budget = computeTimeBudget(
      result.progressionModules,
      undefined,
      split,
      [{ id: "star_1", type: "star", target: 1, costResources: { gold: 100 } }]
    );

    const node = budget.keyMilestoneTimeline![0];
    // fallback [100,500]：casual 100/(100*0.2)=5；average 100/(300*0.2)≈1.67；hardcore 100/(500*0.2)=1
    expect(node.days.casual).toBe(5);
    expect(node.days.average).toBeCloseTo(1.67, 2);
    expect(node.days.hardcore).toBe(1);
  });

  it("⑥ level 型 relatedModuleId 无法定位时退化为纯材料瓶颈", () => {
    const budget = makeSingleModuleTimeline([
      // relatedModuleId 不存在 → 纯材料瓶颈 200/100 = 2（若误对齐 cumulativeDays@5 会得到 5）
      { id: "level_5_orphan", type: "level", target: 5, relatedModuleId: "nonexistent", costResources: { gold: 200 } },
    ]);

    expect(budget.keyMilestoneTimeline![0].days).toEqual({ casual: 2, average: 2, hardcore: 2 });
  });

  it("⑦ 空 costResources 不抛异常：纯空节点三档 days=0，level 型仍可从 cumulativeDays 取值", () => {
    const budget = makeSingleModuleTimeline([
      { id: "bt_0", type: "breakthrough", target: 0, costResources: {} },
      { id: "level_5_free", type: "level", target: 5, relatedModuleId: "level_line", costResources: {} },
    ]);

    const [emptyNode, levelNode] = budget.keyMilestoneTimeline!;
    expect(emptyNode.days).toEqual({ casual: 0, average: 0, hardcore: 0 });
    // 材料瓶颈 0 与 cumulativeDays@5=5 取 max → 5
    expect(levelNode.days).toEqual({ casual: 5, average: 5, hardcore: 5 });
  });

  it("②b 未传 keyMilestones 时返回不含 keyMilestoneTimeline 键（向后兼容）", () => {
    const result = computeProgressionFromIntent(makeProgressionIntent());
    const budget = computeTimeBudget(result.progressionModules, economyBudget, split);
    expect("keyMilestoneTimeline" in budget).toBe(false);
    expect(budget.keyMilestoneTimeline).toBeUndefined();
  });
});

// ==================== 产消阶段差异（V8 W2-T4b R5：tierStageFactors） ====================

/**
 * 手工可验算模块：每级恒定 gold 100 + 预算 {gold:[100,100]} + split 1（单模块全额）
 * → 无因子时三档（casual/average/hardcore）每级恒 1 天（cum@N = N）。
 * 传因子后 daysToNext = 100/(100×f) = 1/f，期望值全部经引擎式验算（非心算）。
 */
function makeFlatCostModule(id: string, maxLevel: number): ProgressionModuleResult {
  return {
    id,
    name: `${id}线`,
    focus: "ATK",
    maxLevel,
    curveType: "linear",
    contributionToAttributes: {},
    resourceCostTable: Array.from({ length: maxLevel }, (_, i) => ({
      level: i + 1,
      resourceCost: { gold: 100 },
      cumulativeCost: { gold: 100 * (i + 1) },
    })),
  };
}

const FLAT_BUDGET: Record<string, [number, number]> = { gold: [100, 100] };

describe("computeTimeBudget — tierStageFactors 产消阶段差异（R5）", () => {
  it("缺省因子 [1,2,4] 三档展开：tierCount=3 恰逐档直取，dailyAvailable × 因子", () => {
    const budget = computeTimeBudget(
      [makeFlatCostModule("m", 10)],
      FLAT_BUDGET,
      1,
      undefined,
      [1, 2, 4]
    );

    // maxLevel=10 → ratio=L/10：L1,L2 ≤0.2 → early f=1；L3..L7 ≤0.7 → mid f=2；L8..L10 → late f=4
    // daysToNext = 100/(100×f)：early=1 / mid=0.5 / late=0.25（预算三档同值 → 三档天数同）
    const t = budget.modules[0].levelTable;
    expect(t[0].daysToNext.average).toBe(1); // L1 early
    expect(t[2].daysToNext.average).toBe(0.5); // L3 mid
    expect(t[7].daysToNext.average).toBe(0.25); // L8 late
    expect(t[7].daysToNext).toEqual({ casual: 0.25, average: 0.25, hardcore: 0.25 });
    // cumulativeDays：cum@3 = 1+1+0.5 = 2.5；cum@8 = 2+0.5×5+0.25 = 4.75；cum@10 = 4.75+0.25×2 = 5.25
    expect(t[2].cumulativeDays.average).toBe(2.5);
    expect(t[7].cumulativeDays.average).toBe(4.75);
    expect(t[9].cumulativeDays.average).toBe(5.25);
  });

  it("speedComparison 与 milestones 消费含因子的行级天数（同输出口径）", () => {
    const budget = computeTimeBudget(
      [makeFlatCostModule("m", 10)],
      FLAT_BUDGET,
      1,
      undefined,
      [1, 2, 4]
    );
    // early 段 rows 1-2 → (1+1)/2 = 1；mid 段 rows 3-7 → 0.5；late 段 rows 8-10 → 0.25
    expect(budget.speedComparison.map((p) => p.averageDaysPerLevel)).toEqual([1, 0.5, 0.25]);
    // milestones（无 keyNodes 现三点）：前期=round(10/3)=3 → cum@3=2.5；半程=5 → cum@5=3.5；满级=10 → 5.25
    const ms = budget.modules[0].milestones;
    expect(ms.map((m) => m.levelRange)).toEqual(["1-3", "1-5", "1-10"]);
    expect(ms.map((m) => m.days.average)).toEqual([2.5, 3.5, 5.25]);
  });

  it("不传参 = 现行为（函数级兼容门）：无因子每级 1 天，显式 undefined/空数组/畸形数组全等", () => {
    const mod = makeFlatCostModule("m", 10);
    const baseline = computeTimeBudget([mod], FLAT_BUDGET, 1);
    // 无因子现行为：每级 1 天，cum@10 = 10
    expect(baseline.modules[0].levelTable[9].cumulativeDays.average).toBe(10);
    expect(computeTimeBudget([mod], FLAT_BUDGET, 1, undefined, undefined)).toEqual(baseline);
    // 空数组 → 视为 undefined = 无因子
    expect(computeTimeBudget([mod], FLAT_BUDGET, 1, undefined, [])).toEqual(baseline);
    // 含非有限数的畸形数组 → 整体视为无因子（不部分采纳）
    expect(computeTimeBudget([mod], FLAT_BUDGET, 1, undefined, [1, Number.NaN])).toEqual(baseline);
  });

  it("tierCount≠3 按归一位置插值：[1,1.8,3.2,6] 的 mid 因子 = 1.8+(3.2-1.8)×0.5 = 2.5、late = 6", () => {
    const budget = computeTimeBudget(
      [makeFlatCostModule("m", 10)],
      FLAT_BUDGET,
      1,
      undefined,
      [1, 1.8, 3.2, 6]
    );
    // s=0.5 → pos=0.5×(4-1)=1.5 → f[1]+(f[2]-f[1])×0.5 = 2.5 → L5 daysToNext = 100/250 = 0.4
    expect(budget.modules[0].levelTable[4].daysToNext.average).toBe(0.4);
    // s=0 → pos=0 → f=1 → L1 daysToNext = 1
    expect(budget.modules[0].levelTable[0].daysToNext.average).toBe(1);
    // s=1 → pos=3 → f[3]=6 → L10 daysToNext = 100/600 = 1/6
    expect(budget.modules[0].levelTable[9].daysToNext.average).toBeCloseTo(1 / 6, 10);
    // cum@10 = 1+1+0.4×5+(1/6)×3 = 2+2+0.5 = 4.5
    expect(budget.modules[0].levelTable[9].cumulativeDays.average).toBe(4.5);
  });

  it("两档数组插值：[1,3] 的 mid 因子 = 1+(3-1)×0.5 = 2 → L5 daysToNext = 0.5", () => {
    const budget = computeTimeBudget(
      [makeFlatCostModule("m", 10)],
      FLAT_BUDGET,
      1,
      undefined,
      [1, 3]
    );
    expect(budget.modules[0].levelTable[4].daysToNext.average).toBe(0.5);
    // late：pos=1 → f=3 → L10 = 100/300 = 1/3
    expect(budget.modules[0].levelTable[9].daysToNext.average).toBeCloseTo(1 / 3, 10);
  });

  it("keyMilestoneTimeline 同乘因子：level 型与 cumulativeDays 同轴，star 型无等级轴不虚构因子", () => {
    // 单模块每级 100、预算 [100,100]、split 1、因子 [1,2,4]：
    // level 型 target=5 → ratio 0.5 → mid f=2 → 材料瓶颈 = 200/(100×2) = 1；
    //   cum@5（行级已含因子）= 3.5 → max(1, 3.5) = 3.5（两支同口径，防分裂）
    // star 型 target=3（星数，无等级轴语义）→ 不虚构因子 f=1 → 材料瓶颈 = 200/100 = 2（现口径）
    const budget = computeTimeBudget(
      [makeFlatCostModule("level_line", 10)],
      FLAT_BUDGET,
      1,
      [
        {
          id: "level_5",
          type: "level",
          target: 5,
          relatedModuleId: "level_line",
          costResources: { gold: 200 },
        },
        { id: "star_3", type: "star", target: 3, costResources: { gold: 200 } },
      ],
      [1, 2, 4]
    );

    const [levelNode, starNode] = budget.keyMilestoneTimeline!;
    expect(levelNode.days.average).toBe(3.5);
    expect(starNode.days.average).toBe(2);
  });
});

// ==================== 阶段边界口径单源（V8 W3-T5 Spec R6：⌈⌉ 段末含端绝对等级） ====================

describe("stageFactorAtLevel 边界口径（Spec R6：与 stageBoundsToLevels 绝对等级单源一致）", () => {
  it("非整除 maxLevel=31：earlyEnd=⌈0.2×31⌉=⌈6.2⌉=7 → level 7 归 early 非 mid，lateStart=⌈21.7⌉=22", () => {
    // stageBoundsToLevels([0.2,0.7], 31) = [7, 22]（段末含端：7 属 early、22 属 mid）
    // 旧 ratio 口径：7/31 ≈ 0.226 > 0.2 → level 7 归 mid——本用例钉死新口径
    const budget = computeTimeBudget(
      [makeFlatCostModule("m", 31)],
      FLAT_BUDGET,
      1,
      undefined,
      [1, 2, 4]
    );
    const t = budget.modules[0].levelTable;
    // L7 ≤ earlyEnd=7 → early f=1 → daysToNext = 100/(100×1) = 1
    expect(t[6].daysToNext.average).toBe(1);
    // L8 > 7 → mid f=2 → 100/(100×2) = 0.5
    expect(t[7].daysToNext.average).toBe(0.5);
    // L22 ≤ lateStart=22 → mid f=2 → 0.5（段末含端）
    expect(t[21].daysToNext.average).toBe(0.5);
    // L23 > 22 → late f=4 → 100/(100×4) = 0.25
    expect(t[22].daysToNext.average).toBe(0.25);
  });

  it("小 maxLevel=4：bounds [⌈0.8⌉, ⌈2.8⌉] = [1,3] → level 1 归 early（前期恒非空，W2 Follow-up ④）", () => {
    // 旧 ratio 口径：1/4 = 0.25 > 0.2 → level 1 归 mid——本用例钉死新口径
    const budget = computeTimeBudget(
      [makeFlatCostModule("m", 4)],
      FLAT_BUDGET,
      1,
      undefined,
      [1, 2, 4]
    );
    const t = budget.modules[0].levelTable;
    expect(t[0].daysToNext.average).toBe(1); // L1 ≤ 1 → early f=1 → 1
    expect(t[1].daysToNext.average).toBe(0.5); // L2 ≤ 3 → mid f=2 → 0.5
    expect(t[3].daysToNext.average).toBe(0.25); // L4 > 3 → late f=4 → 0.25
  });

  it("maxLevel=1 退化：bounds [⌈0.2⌉, ⌈0.7⌉] 钳制 [1,1] → level 1 归 early f=1", () => {
    // 旧 ratio 口径：1/1 = 1 > 0.7 → late f=4 → 0.25——本用例钉死新口径
    const budget = computeTimeBudget(
      [makeFlatCostModule("m", 1)],
      FLAT_BUDGET,
      1,
      undefined,
      [1, 2, 4]
    );
    expect(budget.modules[0].levelTable[0].daysToNext.average).toBe(1);
  });
});

// ==================== 里程碑消费推导节点（V8 W2-T6c R8：keyNodes） ====================

describe("computeTimeBudget — keyNodes 里程碑节点（R8）", () => {
  it("keyNodes 传入：里程碑节点 = keyNodes 各节点累计天数（与现固定三点区分）", () => {
    // 每级 1 天（无因子）：cum@2=2 / cum@4=4 / cum@7=7；现三点为 round(10/3)=3、5、10——值域可区分
    const budget = computeTimeBudget(
      [makeFlatCostModule("m", 10)],
      FLAT_BUDGET,
      1,
      undefined,
      undefined,
      [2, 4, 7]
    );

    const ms = budget.modules[0].milestones;
    expect(ms.map((m) => m.levelRange)).toEqual(["1-2", "1-4", "1-7"]);
    expect(ms.map((m) => m.days.average)).toEqual([2, 4, 7]);
    expect(ms.map((m) => m.label)).toEqual(["节点1(1-2级)", "节点2(1-4级)", "节点3(1-7级)"]);
  });

  it("节点超出该模块 maxLevel → 跳过（多模块各自上限不同）", () => {
    // w 线 maxLevel 10：5 命中，15/30 超界跳过 → 1 节点；a 线 maxLevel 20：5/15 命中，30 跳过 → 2 节点
    const budget = computeTimeBudget(
      [makeFlatCostModule("w", 10), makeFlatCostModule("a", 20)],
      FLAT_BUDGET,
      1,
      undefined,
      undefined,
      [5, 15, 30]
    );

    expect(budget.modules[0].milestones.map((m) => m.levelRange)).toEqual(["1-5"]);
    expect(budget.modules[1].milestones.map((m) => m.levelRange)).toEqual(["1-5", "1-15"]);
  });

  it("节点查不到对应行 → 跳过（非兜底末行——静默映射末行会虚报节点天数）", () => {
    // 缺行表：levels [1,2,3,5,7]，maxLevel 7；keyNodes [3,4,6] → 4/6 ≤ maxLevel 但行缺失 → 只剩 1-3
    const gapModule = {
      id: "gap",
      name: "缺行线",
      focus: "ATK",
      maxLevel: 7,
      curveType: "linear",
      contributionToAttributes: {},
      resourceCostTable: [1, 2, 3, 5, 7].map((level) => ({
        level,
        resourceCost: { gold: 100 },
        cumulativeCost: { gold: 100 },
      })),
    } as unknown as ProgressionModuleResult;

    const budget = computeTimeBudget(
      [gapModule],
      FLAT_BUDGET,
      1,
      undefined,
      undefined,
      [3, 4, 6]
    );

    expect(budget.modules[0].milestones.map((m) => m.levelRange)).toEqual(["1-3"]);
    // 对照：若误兜底末行，4/6 会得到 cum@7 = 7（虚报）——此处明确不存在
    expect(budget.modules[0].milestones.map((m) => m.days.average)).toEqual([3]);
  });

  it("无 keyNodes → 现固定三点零变化（undefined / 空数组全等）", () => {
    const mod = makeFlatCostModule("m", 10);
    const baseline = computeTimeBudget([mod], FLAT_BUDGET, 1);

    const ms = baseline.modules[0].milestones;
    expect(ms.map((m) => m.label)).toEqual(["前期(1-3级)", "半程(1-5级)", "满级(1-10级)"]);
    expect(ms.map((m) => m.levelRange)).toEqual(["1-3", "1-5", "1-10"]);
    expect(ms.map((m) => m.days.average)).toEqual([3, 5, 10]);
    // 空数组 → 视为无 keyNodes（S1 恒等）
    expect(
      computeTimeBudget([mod], FLAT_BUDGET, 1, undefined, undefined, [])
    ).toEqual(baseline);
  });

  it("keyNodes 与 tierStageFactors 正交组合：节点天数消费含因子的行级累计", () => {
    // 因子 [1,2,4]：cum@5 = 1+1+0.5×3 = 3.5（节点 5 落 mid 段 f=2）；cum@10 = 5.25（late f=4）
    const budget = computeTimeBudget(
      [makeFlatCostModule("m", 10)],
      FLAT_BUDGET,
      1,
      undefined,
      [1, 2, 4],
      [5, 10]
    );

    const ms = budget.modules[0].milestones;
    expect(ms.map((m) => m.levelRange)).toEqual(["1-5", "1-10"]);
    expect(ms.map((m) => m.days.average)).toEqual([3.5, 5.25]);
  });
});