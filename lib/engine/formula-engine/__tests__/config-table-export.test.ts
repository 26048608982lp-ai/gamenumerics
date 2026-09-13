import { describe, it, expect } from "vitest";
import {
  deriveLevelTable,
  deriveBattleMatrixTable,
  deriveConfigTableDrafts,
  type ConfigTableDraft,
} from "../config-table-export";
import { computeLevelFromIntent } from "../level";
import { computeBattleFromIntent, buildMatrixColumns } from "../battle";
import { BATTLE_INTENT } from "./fixtures";
import { detectColumnPattern, inferColumnRule } from "@/lib/table/pattern";
import type { AnyDesignIntent } from "../types";

/**
 * 配置表草稿导出 round-trip 测试（V10-W3 T2，Spec §二核心判据）：
 *
 * 断言值全部来自引擎实跑真值（禁心算——fixture 为自造锚点，先跑
 * computeLevelFromIntent / computeBattleFromIntent 取值再落断言）：
 * - 等差列（关卡序号 / linear 整除难度 / 战力 / 奖励）→ detectColumnPattern /
 *   inferColumnRule 还原 diff，与生成参数逐字段相等；
 * - 常数列（clear_only 战力 0 哨兵 / 恒值难度）→ constant 还原；
 * - 曲线插值列（exponential 归一化指数 + 取整）→ 模式识别不命中 → 如实标注
 *   「非规则列」不算失败（N2）；
 * - 取整扰动列（linear 非整除 diff）→ inferColumnRule 容错拟合还原参数，
 *   ±0.5 取整容差（lib/table 既有口径）；
 * - 等比列还原 ratio 判据：引擎曲线族（linear/exponential/sigmoid，exponential
 *   为归一化指数非几何级数）不产严格等比列，以判据工具能力桥接断言覆盖；
 * - battle 矩阵跨线投放列（设计矩阵非曲线）→ 非规则列如实标注；
 * - 结构 round-trip（数据零丢失）：导出行反解回 levels / allocationMatrix 逐字段相等。
 */

// ==================== 真链路 fixture（自造锚点 + 引擎 computed 产物） ====================

/**
 * round-trip 友好锚点：
 * - main：linear 10→48 / count=20 → 名义 diff=(48−10)/19=2（整除，取整无损 → 严格等差）
 * - trial：exponential 10→100 / count=20 → 归一化指数取整 → 非规则列
 * - free：linear 10→10（恒值难度）+ clear_only → 战力 0 哨兵常数列
 */
const RT_LEVEL_INTENT: Extract<AnyDesignIntent, { moduleType: "level" }> = {
  moduleType: "level",
  decisions: { levelScale: "medium", totalLevels: 50, rationale: "round-trip fixture" },
  strategy: {
    levelTypes: [
      { id: "main", name: "主线", count: 20, difficultyCurve: "linear", rewardResourceTypes: ["gold"] },
      { id: "trial", name: "试炼", count: 20, difficultyCurve: "exponential", rewardResourceTypes: ["gold"] },
      { id: "free", name: "闲游", count: 10, difficultyCurve: "linear", gateType: "clear_only", rewardResourceTypes: [] },
    ],
    progressionPacing: { early: "1-2min", mid: "3-5min", late: "5-10min" },
  },
  anchors: {
    firstLevelDifficulty: { main: 10, trial: 10, free: 10 },
    lastLevelDifficulty: { main: 48, trial: 100, free: 10 },
  },
};

/** 取整扰动锚点：linear 10→95 / count=10 → 名义 diff=85/9=9.444…（非整除，round 引入 ±0.5 波动） */
const NONDIV_LEVEL_INTENT: Extract<AnyDesignIntent, { moduleType: "level" }> = {
  ...RT_LEVEL_INTENT,
  strategy: {
    ...RT_LEVEL_INTENT.strategy,
    levelTypes: [
      { id: "coarse", name: "粗粒度", count: 10, difficultyCurve: "linear", rewardResourceTypes: [] },
    ],
  },
  anchors: {
    firstLevelDifficulty: { coarse: 10 },
    lastLevelDifficulty: { coarse: 95 },
  },
};

/** extended-6 结构决策（special 聚合列在场的 5 列矩阵形态） */
const EXTENDED6_DECISIONS = {
  formationSize: 5,
  battlePace: "turn-based" as const,
  heroStarEnabled: true,
  equipmentEnabled: true,
  equipmentCategories: 4,
  petEnabled: true,
  skillDepth: "upgrade" as const,
  attributeScheme: "extended-6" as const,
  specialAttrFocus: "none" as const,
};

const levelConfirmed = computeLevelFromIntent(RT_LEVEL_INTENT);
const battleConfirmed = computeBattleFromIntent(BATTLE_INTENT);
const battleExt6Confirmed = computeBattleFromIntent({
  ...BATTLE_INTENT,
  structuralDecisions: EXTENDED6_DECISIONS,
});

const levelDrafts = deriveLevelTable(levelConfirmed);
const mainDraft = levelDrafts.find((d) => d.tableName === "level/main-等级成长")!;
const trialDraft = levelDrafts.find((d) => d.tableName === "level/trial-等级成长")!;
const freeDraft = levelDrafts.find((d) => d.tableName === "level/free-等级成长")!;
const battleDraft = deriveBattleMatrixTable(battleConfirmed)!;

/** 取导出表单列数值序列（round-trip 判据输入） */
const columnOf = (draft: ConfigTableDraft, col: string): number[] =>
  draft.rows.map((r) => r[col] as number);

// ==================== 导出形状 ====================

describe("deriveLevelTable — 导出形状", () => {
  it("每 levelType 一张表：表名 level/<id>-等级成长 + 工作区路径 tables/ 下，行数 = count", () => {
    expect(levelDrafts.map((d) => d.tableName)).toEqual([
      "level/main-等级成长",
      "level/trial-等级成长",
      "level/free-等级成长",
    ]);
    for (const draft of levelDrafts) {
      expect(draft.module).toBe("level");
      expect(draft.path).toBe(`tables/${draft.tableName}.json`);
    }
    expect(mainDraft.rows).toHaveLength(20);
    expect(trialDraft.rows).toHaveLength(20);
    expect(freeDraft.rows).toHaveLength(10);
  });

  it("行列形状与工作区规范化表同构（点分复合列名，首行实跑真值）", () => {
    expect(mainDraft.rows[0]).toEqual({
      关卡序号: 1,
      关卡名称: "主线 1",
      难度分: 10,
      推荐战力: 600,
      "奖励.gold": 30,
    });
    expect(freeDraft.rows[0]).toEqual({
      关卡序号: 1,
      关卡名称: "闲游 1",
      难度分: 10,
      推荐战力: 0, // clear_only 落 0 哨兵（level.ts P1-2 契约）
    });
  });

  it("levelTypes 空 / levels 空数组的类型跳过（诚实缺席，不产空表）", () => {
    expect(deriveLevelTable({ levelTypes: [] })).toEqual([]);
    expect(
      deriveLevelTable({
        levelTypes: [{ ...RT_LEVEL_INTENT.strategy.levelTypes[0], levels: [] }],
      })
    ).toEqual([]);
  });
});

describe("deriveBattleMatrixTable — 导出形状", () => {
  it("单张表：行=成长线（classic-4 默认结构 6 线），列=四维投放值直映射", () => {
    expect(battleDraft.tableName).toBe("battle/属性投放矩阵");
    expect(battleDraft.path).toBe("tables/battle/属性投放矩阵.json");
    expect(battleDraft.module).toBe("battle");
    expect(battleDraft.rows).toHaveLength(6);
    // 首行实跑真值（hero 线投放）
    expect(battleDraft.rows[0]).toEqual({
      成长线ID: "hero",
      成长线: "英雄本体（含升星）",
      "投放.攻击": 40,
      "投放.防御": 15,
      "投放.生命": 35,
      "投放.速度": 10,
    });
  });

  it("extended-6 → special 聚合列在场（列头=特殊类目名拼接，buildMatrixColumns 单源）", () => {
    const ext6 = deriveBattleMatrixTable(battleExt6Confirmed)!;
    expect(Object.keys(ext6.rows[0])).toEqual([
      "成长线ID",
      "成长线",
      "投放.攻击",
      "投放.防御",
      "投放.生命",
      "投放.速度",
      "投放.暴击/效果命中",
    ]);
    // pet 线 special 聚合份额 60（实跑真值）
    expect(ext6.rows.find((r) => r["成长线ID"] === "pet")).toEqual({
      成长线ID: "pet",
      成长线: "宠物",
      "投放.攻击": 0,
      "投放.防御": 15,
      "投放.生命": 25,
      "投放.速度": 0,
      "投放.暴击/效果命中": 60,
    });
  });

  it("growthLines / allocationMatrix 空 → null（调用方落 unavailable）", () => {
    expect(deriveBattleMatrixTable({ growthLines: [], attributeCategories: [], allocationMatrix: [] })).toBeNull();
  });
});

// ==================== round-trip 核心判据：模式识别还原生成参数 ====================

describe("round-trip — 等差列还原 diff（与生成参数逐字段相等）", () => {
  it("关卡序号列（生成参数 1..N 步长 1）→ arithmetic {first:1, diff:1}", () => {
    const pattern = detectColumnPattern(columnOf(mainDraft, "关卡序号"));
    expect(pattern).toEqual({ type: "arithmetic", first: 1, diff: 1 });
  });

  it("linear 整除难度列（生成参数 diff=(48−10)/(20−1)=2）→ arithmetic {first:10, diff:2} 逐字段相等", () => {
    // 实跑真值：[10,12,14,…,48]
    expect(columnOf(mainDraft, "难度分").slice(0, 5)).toEqual([10, 12, 14, 16, 18]);
    const pattern = detectColumnPattern(columnOf(mainDraft, "难度分"));
    expect(pattern).toEqual({ type: "arithmetic", first: 10, diff: 2 });
    // inferColumnRule 同口径（容错拟合版）：参数一致 + 全序列吻合
    const inferred = inferColumnRule(columnOf(mainDraft, "难度分"));
    expect(inferred?.best).toMatchObject({ type: "arithmetic", first: 10, diff: 2 });
    expect(inferred?.best?.fitPct).toBe(1);
  });

  it("推荐战力列（难度仿射映射 round(100+d×50)）→ arithmetic {first:600, diff:100}", () => {
    const pattern = detectColumnPattern(columnOf(mainDraft, "推荐战力"));
    expect(pattern).toEqual({ type: "arithmetic", first: 600, diff: 100 });
  });

  it("奖励列（难度仿射映射 round(10+d×2)）→ arithmetic {first:30, diff:4}", () => {
    const pattern = detectColumnPattern(columnOf(mainDraft, "奖励.gold"));
    expect(pattern).toEqual({ type: "arithmetic", first: 30, diff: 4 });
  });
});

describe("round-trip — 常数列还原 value", () => {
  it("恒值难度列（free 锚点 10→10）→ constant {value:10}", () => {
    expect(detectColumnPattern(columnOf(freeDraft, "难度分"))).toEqual({
      type: "constant",
      value: 10,
    });
  });

  it("clear_only 战力 0 哨兵列 → constant {value:0}", () => {
    expect(detectColumnPattern(columnOf(freeDraft, "推荐战力"))).toEqual({
      type: "constant",
      value: 0,
    });
  });
});

describe("round-trip — 曲线插值列如实标注「非规则列」（N2，不算失败）", () => {
  it("exponential 难度列（归一化指数取整）→ detectColumnPattern 与 inferColumnRule 双不命中", () => {
    // 实跑真值：[10,13,17,20,24,28,32,36,41,45,50,54,59,65,70,76,81,87,94,100]
    expect(columnOf(trialDraft, "难度分").slice(0, 6)).toEqual([10, 13, 17, 20, 24, 28]);
    expect(detectColumnPattern(columnOf(trialDraft, "难度分"))).toBeNull();
    expect(inferColumnRule(columnOf(trialDraft, "难度分"))?.best).toBeNull();
  });

  it("battle 矩阵跨线投放列（设计矩阵非曲线）→ 非规则列", () => {
    for (const col of ["投放.攻击", "投放.防御", "投放.生命", "投放.速度"]) {
      expect(detectColumnPattern(columnOf(battleDraft, col)), col).toBeNull();
    }
  });
});

describe("round-trip — 取整扰动列：inferColumnRule ±0.5 容差还原生成参数", () => {
  const coarseConfirmed = computeLevelFromIntent(NONDIV_LEVEL_INTENT);
  const coarseDraft = deriveLevelTable(coarseConfirmed)[0];

  it("非整除 linear（名义 diff=85/9）→ 严格识别不立论，容错拟合还原 |Δ|≤0.5", () => {
    // 实跑真值：取整后 [10,19,29,38,48,57,67,76,86,95]（diffs 交替 9/10）
    expect(columnOf(coarseDraft, "难度分")).toEqual([10, 19, 29, 38, 48, 57, 67, 76, 86, 95]);
    // 全序列严格吻合不立论（±1 取整波动超出识别容差）
    expect(detectColumnPattern(columnOf(coarseDraft, "难度分"))).toBeNull();
    // 容错拟合：arithmetic 族立论，参数与生成参数（first=10，diff=85/9）差 ≤0.5（取整容差）
    const best = inferColumnRule(columnOf(coarseDraft, "难度分"))?.best;
    expect(best?.type).toBe("arithmetic");
    if (best?.type === "arithmetic") {
      expect(Math.abs(best.first - 10)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(best.diff - 85 / 9)).toBeLessThanOrEqual(0.5);
      expect(best.fitPct).toBeGreaterThanOrEqual(0.8);
    } else {
      throw new Error("arithmetic 拟合未立论");
    }
  });
});

describe("round-trip — 等比列还原 ratio（判据工具能力桥接）", () => {
  /**
   * 引擎现有曲线族（interpolateCurve linear/exponential/sigmoid——exponential 为
   * 归一化指数 start+(end−start)·(f^t−1)/(f−1)，非几何级数 a·r^i）不产严格等比列，
   * level/battle 两表导出列中无等比实例；「等比列还原 ratio」判据以 pattern 工具
   * 能力桥接断言覆盖（若导出表含严格等比列——如设计将升级经验设为等比——
   * detectColumnPattern 能逐字段还原生成参数）。
   */
  it("严格等比序列（生成参数 first=100, ratio=2）→ geometric 逐字段相等", () => {
    expect(detectColumnPattern([100, 200, 400, 800, 1600])).toEqual({
      type: "geometric",
      first: 100,
      ratio: 2,
    });
    const inferred = inferColumnRule([100, 200, 400, 800, 1600]);
    expect(inferred?.best).toMatchObject({ type: "geometric", first: 100, ratio: 2 });
    expect(inferred?.best?.fitPct).toBe(1);
  });
});

// ==================== 结构 round-trip（数据零丢失） ====================

describe("round-trip — 结构反解（导出行 → 源产物逐字段相等）", () => {
  it("level 表行反解回 levels 数组：levelIndex/levelName/difficultyScore/recommendedPower/rewardEstimate 逐字段相等", () => {
    for (const [i, lt] of levelConfirmed.levelTypes.entries()) {
      const draft = levelDrafts[i];
      const restored = draft.rows.map((r) => ({
        levelIndex: r["关卡序号"],
        levelName: r["关卡名称"],
        difficultyScore: r["难度分"],
        recommendedPower: r["推荐战力"],
        // 奖励.<资源id> 前缀列反解回 rewardEstimate（无奖励资源 → 空对象，与引擎产物恒有键一致）
        rewardEstimate: Object.fromEntries(
          Object.entries(r)
            .filter(([k]) => k.startsWith("奖励."))
            .map(([k, v]) => [k.slice(3), v])
        ),
      }));
      expect(restored).toEqual(lt.levels);
    }
  });

  it("battle 表行反解回 allocationMatrix：growthLineId + 各属性 weightPct 逐字段相等（列定义 buildMatrixColumns 同源）", () => {
    const columns = buildMatrixColumns(battleConfirmed.attributeCategories);
    const restored = battleDraft.rows.map((r) => ({
      growthLineId: r["成长线ID"],
      allocations: columns.map((col) => ({
        attributeId: col.id,
        weightPct: r[`投放.${col.label}`],
      })),
    }));
    expect(restored).toEqual(
      battleConfirmed.allocationMatrix.map((row) => ({
        growthLineId: row.growthLineId,
        allocations: row.allocations.map(({ attributeId, weightPct }) => ({
          attributeId,
          weightPct,
        })),
      }))
    );
  });
});

// ==================== refs 全景与确定性 ====================

describe("deriveConfigTableDrafts — refs 全景", () => {
  it("全源：level/battle 填真实表引用，未开通模块（economy/progression/gacha）显式 unavailable + 原因含 V11", () => {
    const bundle = deriveConfigTableDrafts({ level: levelConfirmed, battle: battleConfirmed });
    expect(bundle.drafts.map((d) => d.tableName)).toEqual([
      "level/main-等级成长",
      "level/trial-等级成长",
      "level/free-等级成长",
      "battle/属性投放矩阵",
    ]);
    expect(bundle.refs.level).toEqual({
      tables: [
        { tableName: "level/main-等级成长", path: "tables/level/main-等级成长.json" },
        { tableName: "level/trial-等级成长", path: "tables/level/trial-等级成长.json" },
        { tableName: "level/free-等级成长", path: "tables/level/free-等级成长.json" },
      ],
    });
    expect(bundle.refs.battle).toEqual({
      tables: [{ tableName: "battle/属性投放矩阵", path: "tables/battle/属性投放矩阵.json" }],
    });
    for (const moduleKey of ["economy", "progression", "gacha"]) {
      expect(bundle.refs[moduleKey]).toEqual({
        unavailable: true,
        reason: expect.stringContaining("最小版未开通"),
      });
      expect((bundle.refs[moduleKey] as { reason: string }).reason).toContain("V11");
    }
  });

  it("空源 / 半源：缺席模块落 unavailable（confirmed 缺席原因），refs 键集恒 5 个", () => {
    const empty = deriveConfigTableDrafts({});
    expect(Object.keys(empty.refs)).toEqual(["level", "battle", "economy", "progression", "gacha"]);
    expect(empty.refs.level).toEqual({
      unavailable: true,
      reason: expect.stringContaining("level confirmed 缺席"),
    });
    expect(empty.refs.battle).toEqual({
      unavailable: true,
      reason: expect.stringContaining("battle confirmed 缺席"),
    });

    const levelOnly = deriveConfigTableDrafts({ level: levelConfirmed });
    expect(levelOnly.refs.battle).toEqual({
      unavailable: true,
      reason: expect.stringContaining("battle confirmed 缺席"),
    });
    expect(levelOnly.drafts.map((d) => d.module)).toEqual(["level", "level", "level"]);
  });

  it("确定性：相同输入两次调用输出深度相等且非同一引用", () => {
    const a = deriveConfigTableDrafts({ level: levelConfirmed, battle: battleConfirmed });
    const b = deriveConfigTableDrafts({ level: levelConfirmed, battle: battleConfirmed });
    expect(a).toEqual(b);
    expect(a.drafts).not.toBe(b.drafts);
    expect(a.drafts[0].rows).not.toBe(b.drafts[0].rows);
  });

  it("不变异入参（confirmed 快照对照）", () => {
    const sources = { level: levelConfirmed, battle: battleConfirmed };
    const snapshot = JSON.parse(JSON.stringify(sources));
    deriveConfigTableDrafts(sources);
    expect(sources).toEqual(snapshot);
  });
});
