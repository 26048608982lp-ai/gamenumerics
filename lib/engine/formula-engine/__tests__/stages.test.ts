import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STAGE_BOUNDS_DEFAULT,
  deriveKeyNodes,
  deriveStageBounds,
  stageBoundsToLevels,
  clampLineSchedule,
  type LineSchedule,
  type StageFocus,
} from "../stages";
import { computeTimeBudget, type ProgressionModuleResult } from "../progression";

const testDir = path.dirname(fileURLToPath(import.meta.url));

function readEngineSource(fileName: string): string {
  return readFileSync(path.join(testDir, "..", fileName), "utf-8");
}

/**
 * 提取顶层 function 源码切片（至下一个顶层函数声明为止）。
 * S4 单源断言只针对「阶段切分语义位」——Spec 明示机械 grep 0.2/0.7
 * 会误命中咬合阈值/pace 因子等非语义位，故按函数粒度切片断言。
 */
function extractTopLevelFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `源文件应包含 function ${name}`).toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  const nextDecl = rest.search(/\n(?:export )?function /);
  return nextDecl === -1 ? src.slice(start) : src.slice(start, start + 1 + nextDecl);
}

describe("STAGE_BOUNDS_DEFAULT（V8 W2-T1 阶段口径单源）", () => {
  it("缺省阶段边界为 [0.2, 0.7]", () => {
    expect(STAGE_BOUNDS_DEFAULT).toEqual([0.2, 0.7]);
  });

  it("S4 单源：level-reward.ts 语义位 import STAGE_BOUNDS_DEFAULT，computeRewardSchedule 内无独立边界字面量", () => {
    const src = readEngineSource("level-reward.ts");
    expect(src).toContain('import { STAGE_BOUNDS_DEFAULT } from "./stages"');
    const fn = extractTopLevelFunction(src, "computeRewardSchedule");
    expect(fn).not.toContain("startFrac: 0.2");
    expect(fn).not.toContain("endFrac: 0.2");
    expect(fn).not.toContain("startFrac: 0.7");
    expect(fn).not.toContain("endFrac: 0.7");
  });

  it("S4 单源：progression.ts buildSpeedComparison 消费 STAGE_BOUNDS_DEFAULT，无三等分字面量", () => {
    const src = readEngineSource("progression.ts");
    expect(src).toContain('import { STAGE_BOUNDS_DEFAULT } from "./stages"');
    const fn = extractTopLevelFunction(src, "buildSpeedComparison");
    expect(fn).toContain("STAGE_BOUNDS_DEFAULT");
    expect(fn).not.toContain("1 / 3");
    expect(fn).not.toContain("2 / 3");
  });

  it("R6 单源：stageFactorAtLevel 消费 stageBoundsToLevels 绝对等级（无 ratio 分数比较残留）", () => {
    const src = readEngineSource("progression.ts");
    const fn = extractTopLevelFunction(src, "stageFactorAtLevel");
    expect(fn).toContain("stageBoundsToLevels");
    expect(fn).not.toContain("ratio");
  });

  it("R6 单源：buildSpeedComparison 区间组段消费 stageBoundsToLevels（无 startFrac/endFrac 分数切分残留）", () => {
    const src = readEngineSource("progression.ts");
    const fn = extractTopLevelFunction(src, "buildSpeedComparison");
    expect(fn).toContain("stageBoundsToLevels");
    expect(fn).not.toContain("startFrac");
    expect(fn).not.toContain("endFrac");
  });

  it("R6 两构念 docstring 双向记录（stages.ts 文件头）：占比边界段末含端 / openAt 切换段首含端", () => {
    const src = readEngineSource("stages.ts");
    expect(src).toContain("占比边界");
    expect(src).toContain("段末含端");
    expect(src).toContain("openAt 切换");
    expect(src).toContain("段首含端");
  });
});

describe("speedComparison 阶段切分（裁决 A1：三等分 → STAGE_BOUNDS_DEFAULT，已批准行为变化）", () => {
  /**
   * 手工构造「每级天数 = 级数」模块：gold 预算 [1,1] 且单模块份额 1
   * → 三档（casual/average/hardcore）daysToNext 均等于级数，
   * 期望均值经引擎验算（非心算）：
   * early 1-2 级 → (1+2)/2 = 1.5；mid 3-7 级 → (3+4+5+6+7)/5 = 5；
   * late 8-10 级 → (8+9+10)/3 = 9。
   * 旧三等分口径下为 2 / 5 / 8.5（1-3、4-6、7-10）。
   */
  function makeLinearDaysModule(maxLevel: number): ProgressionModuleResult {
    const resourceCostTable = Array.from({ length: maxLevel }, (_, i) => {
      const level = i + 1;
      return {
        level,
        resourceCost: { gold: level },
        cumulativeCost: { gold: (level * (level + 1)) / 2 },
      };
    });
    return {
      id: "main",
      name: "主线",
      focus: "攻击",
      maxLevel,
      curveType: "linear",
      contributionToAttributes: { 攻击: 100 },
      resourceCostTable,
    };
  }

  it("10 级模块切分为 1-2 / 3-7 / 8-10 级，三档每级天数均值 1.5 / 5 / 9", () => {
    const budget = computeTimeBudget([makeLinearDaysModule(10)], { gold: [1, 1] }, 1);
    expect(budget.speedComparison.map((p) => p.phase)).toEqual(["前期", "中期", "后期"]);
    expect(budget.speedComparison.map((p) => p.averageDaysPerLevel)).toEqual([1.5, 5, 9]);
    // 预算三档同值 → casual/average/hardcore 全一致
    expect(budget.speedComparison.map((p) => p.casualDaysPerLevel)).toEqual([1.5, 5, 9]);
    expect(budget.speedComparison.map((p) => p.hardcoreDaysPerLevel)).toEqual([1.5, 5, 9]);
  });

  it("非整除 31 级模块切分为 1-7 / 8-22 / 23-31 级（⌈6.2⌉=7 段末含端），均值 4 / 15 / 27", () => {
    // stageBoundsToLevels([0.2,0.7], 31) = [⌈6.2⌉, ⌈21.7⌉] = [7, 22]
    // 每级天数 = 级数：early = Σ(1..7)/7 = 28/7 = 4；mid = (Σ22−Σ7)/15 = (253−28)/15 = 15；
    // late = (Σ31−Σ22)/9 = (496−253)/9 = 27（Σ22 = 22×23/2 = 253、Σ31 = 31×32/2 = 496）
    // 旧 ⌊⌋+1 口径：[1,6] / [7,21] / [22,31] → 21/6=3.5 / 210/15=14 / 265/10=26.5
    const budget = computeTimeBudget([makeLinearDaysModule(31)], { gold: [1, 1] }, 1);
    expect(budget.speedComparison.map((p) => p.averageDaysPerLevel)).toEqual([4, 15, 27]);
  });

  it("小 maxLevel=4：切分为 1-1 / 2-3 / 4-4 级（前期恒非空，W2 Follow-up ④），均值 1 / 2.5 / 4", () => {
    // stageBoundsToLevels([0.2,0.7], 4) = [⌈0.8⌉, ⌈2.8⌉] = [1, 3]
    // early [1..1] → 1；mid [2..3] → (2+3)/2 = 2.5；late [4..4] → 4
    // 旧 ⌊⌋+1 口径：前期 endLevel = ⌊0.8⌋ = 0 < startLevel = 1 → 空段均值 0（前期被吞）
    const budget = computeTimeBudget([makeLinearDaysModule(4)], { gold: [1, 1] }, 1);
    expect(budget.speedComparison.map((p) => p.averageDaysPerLevel)).toEqual([1, 2.5, 4]);
  });

  it("maxLevel=1 退化：bounds [1,1] 自洽 → 前期 [1,1] 均值 1、中/后期空段 0", () => {
    // early [1..1] → daysToNext@1 = 1；mid [2..1] / late [2..1] 空段 → count 兜底 1 → 0
    // 旧 ⌊⌋+1 口径：前期/中期空段、后期 [⌊0.7⌋+1..⌊1⌋] = [1,1] 命中 → [0, 0, 1]
    // 单级轴上唯一等级归前期（开荒即早期）为 ⌈⌉ 含端口径的正确退化
    const budget = computeTimeBudget([makeLinearDaysModule(1)], { gold: [1, 1] }, 1);
    expect(budget.speedComparison.map((p) => p.averageDaysPerLevel)).toEqual([1, 0, 0]);
  });
});

// ==================== V8 W2-T6a 养成线调度推导（层 2，确定性纯函数）====================

describe("deriveKeyNodes / deriveStageBounds（V8 W2-T6a）", () => {
  /** S9a SLG 节奏 fixture（Spec R6 精确锚定，期望值禁改） */
  const schedule: LineSchedule = {
    lines: {
      hero: { openAt: 1 },
      "equipment-weapon": { openAt: 5 },
      pet: { openAt: 15, unlockLevels: [24, 27, 30] },
    },
  };
  const stages3: StageFocus[] = [
    { name: "开荒期", focusLines: ["hero"] },
    { name: "装备期", focusLines: ["equipment-weapon"] },
    { name: "宠物期", focusLines: ["pet"] },
  ];

  it("S9a 精确锚定：deriveKeyNodes=[5,15,24,27,30]、deriveStageBounds=[5,15]", () => {
    expect(deriveKeyNodes(schedule, 30)).toEqual([5, 15, 24, 27, 30]);
    expect(deriveStageBounds(stages3, schedule, 30)).toEqual([5, 15]);
  });

  it("lineSchedule 缺失 → deriveKeyNodes=[]", () => {
    expect(deriveKeyNodes(undefined, 30)).toEqual([]);
  });

  it("等级 1 为全程起点：hero@1 不入关键节点（开放事件 ∪ 解锁档 − 起点）", () => {
    expect(deriveKeyNodes({ lines: { hero: { openAt: 1 } } }, 30)).toEqual([]);
  });

  it("越界 clamp：openAt/unlockLevels 超出 [1,maxLevel] → 钳制后入节点（去重升序）", () => {
    const clamped: LineSchedule = {
      lines: { "equipment-weapon": { openAt: 99, unlockLevels: [0, 5, 99] } },
    };
    // 99→30、0→1（起点过滤）、5、99→30 去重 → [5, 30]
    expect(deriveKeyNodes(clamped, 30)).toEqual([5, 30]);
  });

  it("focus 线未在 lineSchedule 声明（无 openAt）→ 该切换点无效 → 恰 1 个有效切点回退缺省换算", () => {
    const noWeapon: LineSchedule = {
      lines: { hero: { openAt: 1 }, pet: { openAt: 15 } },
    };
    // stages3 的装备期 focus（equipment-weapon）未声明 → 仅 pet@15 一个有效切换点
    expect(deriveStageBounds(stages3, noWeapon, 30)).toEqual(
      stageBoundsToLevels(STAGE_BOUNDS_DEFAULT, 30),
    );
  });

  it("非恰 2 个有效切换点（2 段 stages → hero@1 过滤后仅 weapon@5）→ 回退缺省换算", () => {
    const twoStages: StageFocus[] = [
      { name: "开荒期", focusLines: ["hero"] },
      { name: "装备期", focusLines: ["equipment-weapon"] },
    ];
    expect(deriveStageBounds(twoStages, schedule, 30)).toEqual(
      stageBoundsToLevels(STAGE_BOUNDS_DEFAULT, 30),
    );
  });

  it("无 stages → 回退缺省换算（maxLevel=60 → [12,42]，与 damage 取样 ⌈L×frac⌉ 同源）", () => {
    expect(deriveStageBounds(undefined, schedule, 60)).toEqual([12, 42]);
  });
});

describe("stageBoundsToLevels（占比 → 绝对等级换算，V8 W2）", () => {
  it("⌈L×frac⌉ 换算并钳制 [1,L]", () => {
    expect(stageBoundsToLevels([0.2, 0.7], 60)).toEqual([12, 42]);
    expect(stageBoundsToLevels([0.2, 0.7], 50)).toEqual([10, 35]);
    expect(stageBoundsToLevels([0.2, 0.7], 30)).toEqual([6, 21]);
    expect(stageBoundsToLevels([0.2, 0.7], 1)).toEqual([1, 1]);
  });

  it("小 maxLevel 边界（Spec R6 / W2 Follow-up ④）：maxLevel=4 → [⌈0.8⌉, ⌈2.8⌉] = [1,3]，earlyEnd ≥ 1 恒成立", () => {
    expect(stageBoundsToLevels([0.2, 0.7], 4)).toEqual([1, 3]);
  });

  it("降序/非有限占比防御：归一升序 / 回退缺省", () => {
    expect(stageBoundsToLevels([0.7, 0.2], 60)).toEqual([12, 42]);
    expect(stageBoundsToLevels([NaN, 0.7], 60)).toEqual([12, 42]);
  });
});

describe("clampLineSchedule（V8 W2-T6a 回显净化）", () => {
  it("openAt/unlockLevels clamp 进 [1,maxLevel]，非有限 openAt 的线丢弃", () => {
    const raw: LineSchedule = {
      lines: {
        "equipment-weapon": { openAt: 99, unlockLevels: [0, 5, 99] },
        pet: { openAt: 15 },
        hero: { openAt: NaN },
      },
    };
    const echoed = clampLineSchedule(raw, 30);
    expect(echoed.lines["equipment-weapon"]).toEqual({ openAt: 30, unlockLevels: [1, 5, 30] });
    expect(echoed.lines.pet).toEqual({ openAt: 15 });
    expect(echoed.lines.hero).toBeUndefined();
  });

  it("unlockLevels 未声明 → 回显不含该键（原样回显语义）", () => {
    const echoed = clampLineSchedule({ lines: { hero: { openAt: 2 } } }, 30);
    expect(echoed.lines.hero).toEqual({ openAt: 2 });
    expect("unlockLevels" in echoed.lines.hero!).toBe(false);
  });
});
