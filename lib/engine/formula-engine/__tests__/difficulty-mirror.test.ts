import { describe, it, expect } from "vitest";
import {
  computeDifficultyMirror,
  TIERS_DEFAULT,
  type MirrorBattleInput,
  type MirrorOptions,
} from "../difficulty-mirror";
import { computeDifficultyMirror as mirrorViaBarrel } from "../index";
import {
  readEnemyStrengthBaseline,
  readHpAtkRatioHint,
  resolveEffectiveTiers,
} from "../difficulty-mirror";
import { resolveEffectiveTiers as resolveEffectiveTiersViaBarrel } from "../index";
import { calcDamage } from "../battle";
import type { ComputedBattleData } from "@/lib/types/planning";

/**
 * W0 战力模型 v2：难度咬合镜像重写——budget 选项删除，断言全部基于
 * 属性供给模型重算（hero 单线 50/30/20 → wp = r_hero(day)）。
 */

/** hero 单线可控画像 fixture：attack/defense/hp 权重 50/30/20（单线 colShare 全 1） */
function makeMirrorBattle(overrides?: {
  attributeCategories?: Array<{ id: string; name: string }>;
  growthTableKeys?: "lower" | "upper";
  combatPacing?: MirrorBattleInput["combatPacing"];
}): MirrorBattleInput {
  const K = overrides?.growthTableKeys === "upper";
  const key = (id: string) => (K ? { attack: "ATK", defense: "DEF", hp: "HP" }[id] ?? id : id);
  return {
    systemSwitches: {
      formationSize: 5,
      battlePace: "turn-based",
      heroStarEnabled: true,
      equipmentEnabled: true,
      equipmentCategories: 4,
      petEnabled: false,
      skillDepth: "upgrade",
      attributeScheme: "classic-4",
      specialAttrFocus: "none",
    },
    growthLines: [{ id: "hero", name: "英雄本体", type: "hero" }],
    attributeCategories: overrides?.attributeCategories ?? [
      { id: "attack", name: "攻击" },
      { id: "defense", name: "防御" },
      { id: "hp", name: "生命" },
    ],
    allocationMatrix: [
      {
        growthLineId: "hero",
        allocations: [
          { attributeId: "attack", role: "primary", weightPct: 50 },
          { attributeId: "defense", role: "secondary", weightPct: 30 },
          { attributeId: "hp", role: "secondary", weightPct: 20 },
        ],
      },
    ],
    attributeGrowthTable: [
      {
        level: 1,
        [key("attack")]: 100,
        [key("defense")]: 50,
        [key("hp")]: 500,
      },
      {
        level: 60,
        [key("attack")]: 5000,
        [key("defense")]: 2000,
        [key("hp")]: 20000,
      },
    ] as ComputedBattleData["attributeGrowthTable"],
    combatPacing: overrides?.combatPacing ?? "standard",
  };
}

/** 无 budget（v2 战力由属性决定）：供给模型参考值 day=7 / standard pace */
const OPTS_BASE: MirrorOptions = { anchors: [7] };

// 供给模型重算：hero 单线 → wp = r_hero(7) = 1 − e^(−k·day)，HERO_K[standard]=0.025
const R7 = 1 - Math.exp(-0.025 * 7);
const ATK7 = 100 + (5000 - 100) * R7;
const DEF7 = 50 + (2000 - 50) * R7;
const HP7 = 500 + (20000 - 500) * R7;

describe("computeDifficultyMirror（W0 v2：供给模型断言，budget 选项已删）", () => {
  it("镜像守恒：enemyAttributes = 供给属性 × coefficient（逐属性）", () => {
    const result = computeDifficultyMirror(makeMirrorBattle(), {
      ...OPTS_BASE,
      formulaType: "reduction",
    });
    const pickValues = (tierId: string) => {
      const entry = result.entries.find((e) => e.tierId === tierId)!;
      return Object.fromEntries(entry.enemyAttributes.map((a) => [a.id, a.value]));
    };
    const easy = pickValues("easy");
    expect(easy.attack).toBeCloseTo(ATK7 * 0.85, 6);
    expect(easy.defense).toBeCloseTo(DEF7 * 0.85, 6);
    expect(easy.hp).toBeCloseTo(HP7 * 0.85, 6);
    const nm = pickValues("nightmare");
    expect(nm.hp).toBeCloseTo(HP7 * 1.5, 6);
  });

  it("大写键 growthTable 经归一读取：与小写键 fixture 同结果（禁裸读）", () => {
    const lower = computeDifficultyMirror(makeMirrorBattle(), {
      ...OPTS_BASE,
      formulaType: "reduction",
    });
    const upper = computeDifficultyMirror(makeMirrorBattle({ growthTableKeys: "upper" }), {
      ...OPTS_BASE,
      formulaType: "reduction",
    });
    expect(upper.entries.map((e) => e.playerKillTurns)).toEqual(
      lower.entries.map((e) => e.playerKillTurns)
    );
    const upperNormal = upper.entries.find((e) => e.tierId === "normal")!;
    expect(
      upperNormal.enemyAttributes.find((a) => a.id === "attack")!.value
    ).toBeCloseTo(ATK7, 6);
  });

  it("系数单调：四档 kills 严格不减，alignment 跨区间序列", () => {
    // multiplicative + 可控数值产生跨三区间的序列（期望值由供给模型+calcDamage 重算）
    const result = computeDifficultyMirror(makeMirrorBattle(), {
      anchors: [7],
      formulaType: "multiplicative",
      tiers: [
        { id: "tiny", name: "微弱", coefficient: 0.5 },
        { id: "normal", name: "普通", coefficient: 1.0 },
        { id: "hard", name: "困难", coefficient: 3.0 },
        { id: "insane", name: "疯狂", coefficient: 8.0 },
      ],
    });
    const kills = result.entries.map((e) => e.playerKillTurns);
    for (let i = 1; i < kills.length; i++) {
      expect(kills[i]).toBeGreaterThanOrEqual(kills[i - 1]);
    }
    const RANK = { under: 0, aligned: 1, over: 2 } as const;
    const ranks = result.entries.map((e) => RANK[e.alignment]);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
    }
    // 期望序列由供给模型重算：perHit(tier c) = calcDamage(ATK7, DEF7×c, multiplicative)
    const expectedKills = [0.5, 1.0, 3.0, 8.0].map((c) => {
      const perHit = calcDamage(ATK7, DEF7 * c, "multiplicative", { atkCoeff: 1, defCoeff: 0.5, K: 100 });
      return Math.max(1, Math.ceil((HP7 * c) / perHit));
    });
    expect(kills).toEqual(expectedKills);
    expect(result.entries.map((e) => e.alignment)).toEqual(["under", "aligned", "over", "over"]);
  });

  it.each([
    { target: 69, expected: "under", label: "ratio=0.69" },
    { target: 70, expected: "aligned", label: "ratio=0.70" },
    { target: 140, expected: "aligned", label: "ratio=1.40" },
    { target: 141, expected: "over", label: "ratio=1.41" },
  ])(
    "判定阈值边界 $label → $expected",
    ({ target, expected }) => {
      // defCoeff=0 使 perHit=atk7 恒定（敌人 DEF 缩放不影响）→ 探针只由 hp×coeff 决定
      // 档位系数取 target×ATK7/HP7（kills=ceil(target) 右端点）
      const result = computeDifficultyMirror(
        {
          ...makeMirrorBattle(),
          damageFormulaFramework: {
            baseFormula: "",
            coefficients: { atkCoeff: 1, defCoeff: 0 },
            description: "",
          },
        },
        {
          ...OPTS_BASE,
          formulaType: "reduction",
          tiers: [{ id: "probe", name: "探针", coefficient: (target * ATK7) / HP7 }],
          targetTurns: 100,
        }
      );
      const entry = result.entries[0];
      expect(entry.playerKillTurns).toBe(target);
      expect(entry.alignment).toBe(expected);
    }
  );

  it("旧数据降级：battle 无结构层字段 → 抛中文 Error 且文案含「重新生成」", () => {
    expect(() =>
      computeDifficultyMirror({ combatPacing: "standard" } as unknown as MirrorBattleInput)
    ).toThrow(/重新生成/);
  });

  it("attributeGrowthTable 缺失 → 经投影引擎同语义抛错（含「重新生成」）", () => {
    const noTable = makeMirrorBattle() as unknown as Record<string, unknown>;
    delete noTable.attributeGrowthTable;
    expect(() =>
      computeDifficultyMirror(noTable as unknown as MirrorBattleInput, OPTS_BASE)
    ).toThrow(/重新生成/);
  });

  it.each([
    {
      label: "perHit=0（atkCoeff=0 使分子为零）",
      coefficients: { atkCoeff: 0, defCoeff: 0.5, K: 100 },
    },
    {
      label: "perHit<0（defCoeff 为负使分母为负）",
      coefficients: { atkCoeff: 1, defCoeff: -0.5, K: 100 },
    },
  ])(
    "multiplicative 单次伤害无效（$label）→ 抛中文 Error 含「重新生成」",
    ({ coefficients }) => {
      expect(() =>
        computeDifficultyMirror(
          {
            ...makeMirrorBattle(),
            damageFormulaFramework: { baseFormula: "", coefficients, description: "" },
          },
          { ...OPTS_BASE, formulaType: "multiplicative" }
        )
      ).toThrow(/重新生成/);
    }
  );

  it("属性构成无 hp 项 → 抛中文 Error 且文案含「重新生成」", () => {
    expect(() =>
      computeDifficultyMirror(
        makeMirrorBattle({
          attributeCategories: [
            { id: "attack", name: "攻击" },
            { id: "speed", name: "速度" },
          ],
        }),
        OPTS_BASE
      )
    ).toThrow(/重新生成/);
  });

  it("缺 attack 项无法定伤害口径 → 抛中文 Error 含「重新生成」", () => {
    expect(() =>
      computeDifficultyMirror(
        makeMirrorBattle({
          attributeCategories: [
            { id: "defense", name: "防御" },
            { id: "hp", name: "生命" },
          ],
        }),
        OPTS_BASE
      )
    ).toThrow(/重新生成/);
  });

  it("目标刀数三级：targetTurns > hpAtkRatioHint > combatPacing 映射（未知 pacing 走 standard）", () => {
    const base = { ...OPTS_BASE, formulaType: "reduction" as const };
    expect(computeDifficultyMirror(makeMirrorBattle(), base).targetTurns).toBe(10); // standard
    expect(
      computeDifficultyMirror(makeMirrorBattle({ combatPacing: "fast" }), base).targetTurns
    ).toBe(6);
    expect(
      computeDifficultyMirror(makeMirrorBattle({ combatPacing: "slow" }), base).targetTurns
    ).toBe(14);
    expect(
      computeDifficultyMirror(makeMirrorBattle(), { ...base, hpAtkRatioHint: 3 }).targetTurns
    ).toBe(3);
    expect(
      computeDifficultyMirror(makeMirrorBattle({ combatPacing: "slow" }), {
        ...base,
        hpAtkRatioHint: 3,
        targetTurns: 42,
      }).targetTurns
    ).toBe(42);
  });

  it("公式类型三级：options.formulaType > damageFormulaFramework 文本匹配 > 默认 reduction（kills 由供给模型重算）", () => {
    const frameworkMultiplicative = {
      baseFormula: "任意表达式",
      coefficients: { atkCoeff: 1, defCoeff: 0.5, K: 100 },
      description: "伤害公式类型: multiplicative",
    };
    const killsOf = (
      formulaType: "reduction" | "multiplicative" | "hybrid",
      coefficients: Record<string, number>
    ) => Math.max(1, Math.ceil(HP7 / calcDamage(ATK7, DEF7, formulaType, coefficients)));

    // 一级：options 显式指定压过 framework 文本（hybrid）
    const forced = computeDifficultyMirror(
      { ...makeMirrorBattle(), damageFormulaFramework: frameworkMultiplicative },
      { ...OPTS_BASE, formulaType: "hybrid" }
    );
    expect(forced.entries.find((e) => e.tierId === "normal")!.playerKillTurns).toBe(
      killsOf("hybrid", { atkCoeff: 1, defCoeff: 0.5 })
    );

    // 二级：description 文本命中 multiplicative
    const texted = computeDifficultyMirror(
      { ...makeMirrorBattle(), damageFormulaFramework: frameworkMultiplicative },
      OPTS_BASE
    );
    expect(texted.entries.find((e) => e.tierId === "normal")!.playerKillTurns).toBe(
      killsOf("multiplicative", { atkCoeff: 1, defCoeff: 0.5, K: 100 })
    );

    // 二级补充：baseFormula 文本命中 reduction
    const viaBaseFormula = computeDifficultyMirror(
      {
        ...makeMirrorBattle(),
        damageFormulaFramework: {
          baseFormula: "ATK*atkCoeff - DEF*defCoeff (reduction style)",
          coefficients: {},
          description: "无类型词",
        },
      },
      { ...OPTS_BASE, formulaType: undefined }
    );
    expect(viaBaseFormula.entries.find((e) => e.tierId === "normal")!.playerKillTurns).toBe(
      killsOf("reduction", {})
    );

    // 三级：无任何线索 → 默认 reduction
    const defaulted = computeDifficultyMirror(makeMirrorBattle(), OPTS_BASE);
    expect(defaulted.entries.find((e) => e.tierId === "normal")!.playerKillTurns).toBe(
      killsOf("reduction", {})
    );
  });

  it("coefficients 来源：framework.coefficients 缺失 → 走引擎默认参数集（calcDamage ?? 链）", () => {
    const battleWith = (coefficients?: Record<string, number>) => ({
      ...makeMirrorBattle(),
      damageFormulaFramework: {
        baseFormula: "",
        ...(coefficients !== undefined ? { coefficients } : {}),
        description: "伤害公式类型: multiplicative",
      } as MirrorBattleInput["damageFormulaFramework"],
    });

    // 显式 {atkCoeff:1, defCoeff:0, K:100}：perHit = ATK7 → kills 由供给模型重算
    const withExplicit = computeDifficultyMirror(battleWith({ atkCoeff: 1, defCoeff: 0, K: 100 }), {
      anchors: [7],
      formulaType: "multiplicative",
    });
    expect(withExplicit.entries.find((e) => e.tierId === "normal")!.playerKillTurns).toBe(
      Math.max(1, Math.ceil(HP7 / calcDamage(ATK7, DEF7, "multiplicative", { atkCoeff: 1, defCoeff: 0, K: 100 })))
    );

    // 缺 coefficients → 引擎默认（defCoeff 0.5）
    const withDefault = computeDifficultyMirror(battleWith(undefined), {
      anchors: [7],
      formulaType: "multiplicative",
    });
    expect(withDefault.entries.find((e) => e.tierId === "normal")!.playerKillTurns).toBe(
      Math.max(1, Math.ceil(HP7 / calcDamage(ATK7, DEF7, "multiplicative", { atkCoeff: 1, defCoeff: 0.5, K: 100 })))
    );
  });

  it("barrel 再导出可用且 moduleType 标识正确；默认四档随结果返回", () => {
    const result = mirrorViaBarrel(makeMirrorBattle(), OPTS_BASE);
    expect(result.moduleType).toBe("difficulty-mirror");
    expect(result.tiers).toEqual(TIERS_DEFAULT);
    expect(result.tiers.map((t) => t.coefficient)).toEqual([0.85, 1.0, 1.25, 1.5]);
    expect(result.entries.every((e) => result.tiers.some((t) => t.id === e.tierId))).toBe(true);
  });
});

/**
 * 契约 D 三导出（agent-p2-tools T1）：弱读 + 组合口径从 DifficultyMirrorBlock
 * 私有逻辑迁移为引擎单源，UI 与 agent 工具同源消费。语义与组件现实现逐行一致。
 */
describe("契约 D 三导出：readEnemyStrengthBaseline / readHpAtkRatioHint / resolveEffectiveTiers", () => {
  describe("readEnemyStrengthBaseline", () => {
    it("正常值：1.2 / 0.75 原样返回", () => {
      expect(readEnemyStrengthBaseline({ enemyStrengthBaseline: 1.2 })).toBe(1.2);
      expect(readEnemyStrengthBaseline({ enemyStrengthBaseline: 0.75 })).toBe(0.75);
    });

    it.each([
      { label: "键缺省", data: {} },
      { label: "非数值（字符串）", data: { enemyStrengthBaseline: "1.2" } },
      { label: "NaN", data: { enemyStrengthBaseline: Number.NaN } },
      { label: "负数", data: { enemyStrengthBaseline: -0.5 } },
    ])("非法值（$label）→ 兜底 1.0", ({ data }) => {
      expect(readEnemyStrengthBaseline(data)).toBe(1.0);
    });

    it.each([
      { label: "null", data: null },
      { label: "undefined", data: undefined },
      { label: "number", data: 42 },
      { label: "string", data: "str" },
    ])("data 非对象（$label）→ 兜底 1.0", ({ data }) => {
      expect(readEnemyStrengthBaseline(data)).toBe(1.0);
    });
  });

  describe("readHpAtkRatioHint", () => {
    it("正常值：_anchors.hpAtkRatio 数值/有限/>0 → 返回该值", () => {
      expect(readHpAtkRatioHint({ _anchors: { hpAtkRatio: 12 } })).toBe(12);
      expect(readHpAtkRatioHint({ _anchors: { hpAtkRatio: 0.5 } })).toBe(0.5);
    });

    it.each([
      { label: "_anchors 为 null", data: { _anchors: null } },
      { label: "_anchors 为字符串", data: { _anchors: "nope" } },
      { label: "_anchors 缺省", data: {} },
      { label: "hpAtkRatio 非数值（字符串）", data: { _anchors: { hpAtkRatio: "12" } } },
      { label: "hpAtkRatio 非有限（NaN）", data: { _anchors: { hpAtkRatio: Number.NaN } } },
      { label: "hpAtkRatio 非有限（Infinity）", data: { _anchors: { hpAtkRatio: Number.POSITIVE_INFINITY } } },
      { label: "hpAtkRatio = 0", data: { _anchors: { hpAtkRatio: 0 } } },
      { label: "hpAtkRatio 负数", data: { _anchors: { hpAtkRatio: -3 } } },
    ])("非法值（$label）→ undefined", ({ data }) => {
      expect(readHpAtkRatioHint(data)).toBeUndefined();
    });

    it.each([
      { label: "null", data: null },
      { label: "undefined", data: undefined },
      { label: "number", data: 42 },
    ])("data 非对象（$label）→ undefined", ({ data }) => {
      expect(readHpAtkRatioHint(data)).toBeUndefined();
    });
  });

  describe("resolveEffectiveTiers", () => {
    it("baseline=1.0：原样返回（toBe 同引用断言）", () => {
      const tiers = [...TIERS_DEFAULT];
      expect(resolveEffectiveTiers(tiers, { enemyStrengthBaseline: 1.0 })).toBe(tiers);
    });

    it("baseline 缺省：原样返回（toBe 同引用断言）", () => {
      const tiers = [...TIERS_DEFAULT];
      expect(resolveEffectiveTiers(tiers, {})).toBe(tiers);
    });

    it("baseline=0.75：逐档 coefficient 相乘，id/name 原样、非同引用", () => {
      const result = resolveEffectiveTiers(TIERS_DEFAULT, { enemyStrengthBaseline: 0.75 });
      expect(result).not.toBe(TIERS_DEFAULT);
      expect(result.map((t) => t.id)).toEqual(["easy", "normal", "hard", "nightmare"]);
      expect(result.map((t) => t.name)).toEqual(TIERS_DEFAULT.map((t) => t.name));
      expect(result.map((t) => t.coefficient)).toEqual(
        TIERS_DEFAULT.map((t) => t.coefficient * 0.75)
      );
      // 原数组不被原地修改（组件受控编辑仍基于用户原始系数）
      expect(TIERS_DEFAULT.map((t) => t.coefficient)).toEqual([0.85, 1.0, 1.25, 1.5]);
    });

    it.each([
      { label: "键缺省", data: {} },
      { label: "NaN", data: { enemyStrengthBaseline: Number.NaN } },
      { label: "负数", data: { enemyStrengthBaseline: -1 } },
      { label: "字符串", data: { enemyStrengthBaseline: "1.2" } },
    ])("baseline 非法值（$label）→ 原样返回（兜底 1.0 分支，toBe）", ({ data }) => {
      const tiers = [...TIERS_DEFAULT];
      expect(resolveEffectiveTiers(tiers, data)).toBe(tiers);
    });

    it("barrel 再导出可用（formula-engine/index.ts）", () => {
      expect(resolveEffectiveTiersViaBarrel(TIERS_DEFAULT, {})).toBe(TIERS_DEFAULT);
    });
  });
});
