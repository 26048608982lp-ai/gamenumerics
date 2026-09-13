import { describe, it, expect } from "vitest";
import {
  computeGrowthProjection,
  computePowerAtDay,
  lineWeight,
  RAMP_LEVELS,
  FOCUS_BOOST_DEFAULT,
  UNLOCK_STEP_GAIN,
} from "../growth-projection";
import { normalizeAttrKey } from "../power";
import type { ComputedGrowthProjection } from "../growth-projection";
import { computeBattleFromIntent } from "../battle";
import type { BattleDesignIntent } from "../types";
import type { ComputedBattleData } from "@/lib/types/planning";

/**
 * W0 战力模型 v2：属性先行正向链（day → 线进度率 r_line ∈[0,1] → 属性供给 →
 * computePowerStats → Power）。断言全部基于供给模型重算（非份额模型手算）。
 */

type StructuralDecisions = NonNullable<BattleDesignIntent["structuralDecisions"]>;

/** scheme → 属性设计（键名大写 ATK + 小写 crit 混合，与 battle-presets 同构） */
const SCHEMA_DESIGNS = {
  "classic-4": {
    primary: ["ATK", "DEF"],
    secondary: ["HP", "SPD"],
    growthModels: { ATK: "linear", DEF: "exponential", HP: "linear", SPD: "linear" },
    level_1: { ATK: 100, DEF: 50, HP: 500, SPD: 10 },
    level_max: { ATK: 5000, DEF: 2000, HP: 20000, SPD: 50 },
  },
  "extended-6": {
    primary: ["ATK", "HP", "crit"],
    secondary: ["DEF", "SPD", "effect-hit"],
    growthModels: {
      ATK: "linear", DEF: "exponential", HP: "linear", SPD: "linear",
      crit: "linear", "effect-hit": "linear",
    },
    level_1: { ATK: 100, DEF: 50, HP: 500, SPD: 10, crit: 5, "effect-hit": 0 },
    level_max: { ATK: 5000, DEF: 2000, HP: 20000, SPD: 50, crit: 25, "effect-hit": 40 },
  },
} as const;

/** 真链路 fixture：经 battle 引擎产出（growthTable 大写 ATK/DEF/HP/SPD 键 + 结构层 4 字段） */
function makeBattleIntentOverrides(
  overrides?: Partial<StructuralDecisions>
): BattleDesignIntent {
  const scheme = overrides?.attributeScheme ?? "classic-4";
  const design = SCHEMA_DESIGNS[scheme === "special-flow" ? "extended-6" : scheme];
  return {
    moduleType: "battle",
    decisions: {
      attributeStyle: "standard",
      attributeCount: 4,
      skillTypeCombo: "standard",
      rationale: "growth projection fixture",
    },
    structuralDecisions: {
      formationSize: 5,
      battlePace: "turn-based",
      heroStarEnabled: true,
      equipmentEnabled: true,
      equipmentCategories: 4,
      petEnabled: false,
      skillDepth: "upgrade-star",
      attributeScheme: "classic-4",
      specialAttrFocus: "equipment",
      ...overrides,
    },
    strategy: {
      combatType: "turnbased",
      attributeDesign: {
        primary: [...design.primary],
        secondary: [...design.secondary],
        growthModels: { ...design.growthModels },
      },
      damageFormula: {
        type: "multiplicative",
        baseFormula: "test",
        coefficients: { atkCoeff: 1.0, defCoeff: 0.5, K: 100 },
      },
      skillFramework: {
        skillTypes: ["active", "passive", "ultimate"],
        maxSkillsPerCharacter: 4,
        cooldownRange: [3, 10],
      },
      combatPacing: "standard",
      expectedCombatDuration: [30, 60],
    },
    anchors: {
      level_1: { ...design.level_1 },
      level_max: { ...design.level_max },
      maxLevel: 50,
      attributeBudgets: { ...design.level_max },
    },
  };
}

function makeBattleData(
  overrides?: Partial<StructuralDecisions>
): ComputedBattleData {
  return computeBattleFromIntent(makeBattleIntentOverrides(overrides));
}

/** 全开组合（special-flow + 6 装备 + 技能 + 宠物 = 9 线，大小写混合键：ATK + crit） */
function makeFullBattleData(): ComputedBattleData {
  return makeBattleData({
    attributeScheme: "extended-6",
    equipmentCategories: 6,
    petEnabled: true,
    skillDepth: "upgrade-star",
  });
}

type ProjectionAnchor = ComputedGrowthProjection["anchors"][number];

function anchorOf(result: ComputedGrowthProjection, day: number): ProjectionAnchor {
  const anchor = result.anchors.find((a) => a.day === day);
  if (!anchor) throw new Error(`anchor day=${day} not found`);
  return anchor;
}

function lineOf(anchor: ProjectionAnchor, id: string) {
  const line = anchor.lines.find((l) => l.id === id);
  if (!line) throw new Error(`line ${id} not found at day=${anchor.day}`);
  return line;
}

function attrOf(anchor: ProjectionAnchor, id: string) {
  const attr = anchor.attributes.find((a) => a.id === id);
  if (!attr) throw new Error(`attribute ${id} not found at day=${anchor.day}`);
  return attr;
}

// ==================== 供给模型参考实现（测试内重算期望值） ====================

/** hero 渐近进度率（growth-projection HERO_K[pace]） */
const HERO_K = { aggressive: 0.04, standard: 0.025, relaxed: 0.015 } as const;
const SHAPE_FACTOR = { aggressive: 0.7, standard: 1, relaxed: 1.4 } as const;
const logProgress = (day: number, shape: number) =>
  Math.pow(Math.log(day) / Math.log(180), shape);

/** 线进度率 r_line(day) ∈ [0,1] */
function lineRatio(
  type: string,
  day: number,
  pace: "aggressive" | "standard" | "relaxed"
): number {
  if (type === "hero") return Math.min(1, 1 - Math.exp(-HERO_K[pace] * day));
  return Math.min(1, logProgress(day, SHAPE_FACTOR[pace]));
}

/** 属性供给期望值：level_1 + (level_max − level_1) × weightedProgress */
function expectedAttr(
  battle: ComputedBattleData,
  categoryKey: string,
  day: number,
  pace: "aggressive" | "standard" | "relaxed" = "standard"
): number {
  // growthTable 首末行（intent 大写键经归一读取）
  const norm = (k: string): string => {
    const map: Record<string, string> = { ATK: "attack", DEF: "defense", HP: "hp", SPD: "speed" };
    return map[k] ?? k.toLowerCase();
  };
  const first = battle.attributeGrowthTable[0] as Record<string, unknown>;
  const last = battle.attributeGrowthTable[battle.attributeGrowthTable.length - 1] as Record<string, unknown>;
  // growthTable 键是 intent 键（ATK…），类目键是小写结构键 → 反查 intent 键
  const intentKey = Object.keys(first).find((k) => k !== "level" && norm(k) === categoryKey);
  const lv1 = intentKey ? Number(first[intentKey]) : 0;
  const lvMax = intentKey ? Number(last[intentKey]) : 0;

  // special 聚合槽均分到特殊类目（classic-4 无特殊类目不适用）
  const specialCategories = battle.attributeCategories.filter(
    (c) => !["attack", "defense", "hp", "speed"].includes(c.id)
  );
  const colTotal = new Map<string, number>();
  const rowShare = new Map<string, Map<string, number>>();
  for (const row of battle.allocationMatrix) {
    const shares = new Map<string, number>();
    for (const alloc of row.allocations) {
      if (alloc.weightPct <= 0) continue;
      const targets =
        alloc.attributeId === "special" && specialCategories.length > 0
          ? specialCategories.map((c) => c.id)
          : [alloc.attributeId];
      for (const t of targets) {
        const w = alloc.weightPct / targets.length;
        shares.set(t, (shares.get(t) ?? 0) + w);
        colTotal.set(t, (colTotal.get(t) ?? 0) + w);
      }
    }
    rowShare.set(row.growthLineId, shares);
  }
  const lineById = new Map(battle.growthLines.map((l) => [l.id, l]));
  let wp = 0;
  for (const [lineId, shares] of rowShare) {
    const share = shares.get(categoryKey);
    if (!share || !colTotal.get(categoryKey)) continue;
    const line = lineById.get(lineId);
    if (!line) continue;
    wp += (share / colTotal.get(categoryKey)!) * lineRatio(line.type, day, pace);
  }
  return lv1 + (lvMax - lv1) * wp;
}

// ==================== S8 存量兼容：结构字段与成长表两态 ====================

describe("computeGrowthProjection — S8 存量兼容（输入契约五键）", () => {
  it("含结构 4 字段 + attributeGrowthTable 的 battle confirmedData 正常推演", () => {
    const result = computeGrowthProjection(makeFullBattleData(), { anchors: [30] });
    expect(result.anchors).toHaveLength(1);
    expect(result.anchors[0].lines.length).toBeGreaterThan(0);
  });

  it("缺结构字段的旧 battle confirmedData → 抛带中文信息的 Error（S8：面板层 catch 降级 null）", () => {
    const legacy = {
      combatPacing: "standard",
      expectedCombatDuration: [30, 60],
      attributeDesign: { primary: ["ATK"], secondary: [], growthModels: {} },
      damageSimulations: [],
      attributeBudgets: {},
    } as unknown as ComputedBattleData;
    expect(() => computeGrowthProjection(legacy, { anchors: [30] })).toThrow(/结构层字段/);
  });

  it("attributeGrowthTable 缺失或空表 → 与结构字段同语义抛错（不静默退化）", () => {
    const noTable = makeBattleData() as unknown as Record<string, unknown>;
    delete noTable.attributeGrowthTable;
    expect(() =>
      computeGrowthProjection(noTable as unknown as ComputedBattleData, { anchors: [30] })
    ).toThrow(/attributeGrowthTable/);

    const emptyTable = { ...makeBattleData(), attributeGrowthTable: [] };
    expect(() =>
      computeGrowthProjection(emptyTable, { anchors: [30] })
    ).toThrow(/attributeGrowthTable/);
  });

  it("部分缺结构字段（仅缺 allocationMatrix）→ 同样抛错不崩", () => {
    const source = makeBattleData();
    const { allocationMatrix: omitted, ...partial } = source;
    void omitted;
    expect(() =>
      computeGrowthProjection(partial as unknown as ComputedBattleData, { anchors: [30] })
    ).toThrow(/allocationMatrix/);
  });
});

// ==================== 输出形状（budget 废弃） ====================

describe("computeGrowthProjection — 输出形状", () => {
  it("默认 options：moduleType / pace / 默认锚点回显；budget 键不再输出", () => {
    const result = computeGrowthProjection(makeFullBattleData());
    expect(result.moduleType).toBe("growth-projection");
    expect(result.pace).toBe("standard");
    expect(result.anchors.map((a) => a.day)).toEqual([7, 30, 90, 180]);
    expect("budget" in result).toBe(false);
  });

  it("ProjectionOptions 不再接受 budget（战力由属性决定）", () => {
    const result = computeGrowthProjection(makeBattleData(), {
      anchors: [30],
      pace: "relaxed",
      heroMaxLevel: 40,
      equipmentMaxQuality: 4,
      // @ts-expect-error budget 已从选项移除
      budget: { day1: 2000, day180: 500000 },
    });
    expect(result.pace).toBe("relaxed");
    expect("budget" in result).toBe(false);
  });
});

// ==================== 供给模型核心：末锚收敛（hero 渐近语义保留） ====================

describe("computeGrowthProjection — 末锚收敛（hero 渐近）", () => {
  it("标准锚 day=180：hero 未独占列（全参与）各属性值 = 供给模型期望值，介于 level_1 与 level_max 之间", () => {
    const battle = makeBattleData();
    const result = computeGrowthProjection(battle, { anchors: [180] });
    const anchor = anchorOf(result, 180);
    for (const key of ["attack", "defense", "hp", "speed"]) {
      const value = attrOf(anchor, key).value;
      const expected = expectedAttr(battle, key, 180);
      expect(value, key).toBeCloseTo(expected, 6);
      expect(value, key).toBeGreaterThanOrEqual(10); // ≥ level_1（该列 level_1 最小值）
      expect(value, key).toBeLessThanOrEqual(
        key === "attack" ? 5000 : key === "defense" ? 2000 : key === "hp" ? 20000 : 50
      );
    }
  });

  it("hero 独占投放的属性列 < level_max（渐近，差 <2%）；hero 未参与列 = level_max 精确", () => {
    // 自定义矩阵：hero 独占 attack，其他线只投 hp → attack 列 wp = r_hero < 1
    const battle = makeBattleData({ skillDepth: "upgrade", equipmentCategories: 2 });
    const trimmed: ComputedBattleData = {
      ...battle,
      allocationMatrix: [
        {
          growthLineId: "hero",
          allocations: [
            { attributeId: "attack", role: "primary", weightPct: 100 },
            { attributeId: "defense", role: "none", weightPct: 0 },
            { attributeId: "hp", role: "none", weightPct: 0 },
            { attributeId: "speed", role: "none", weightPct: 0 },
          ],
        },
        {
          growthLineId: "equipment-weapon",
          allocations: [
            { attributeId: "attack", role: "none", weightPct: 0 },
            { attributeId: "defense", role: "none", weightPct: 0 },
            { attributeId: "hp", role: "primary", weightPct: 100 },
            { attributeId: "speed", role: "none", weightPct: 0 },
          ],
        },
        {
          growthLineId: "equipment-armor",
          allocations: [
            { attributeId: "attack", role: "none", weightPct: 0 },
            { attributeId: "defense", role: "none", weightPct: 0 },
            { attributeId: "hp", role: "primary", weightPct: 100 },
            { attributeId: "speed", role: "none", weightPct: 0 },
          ],
        },
        {
          growthLineId: "skill",
          allocations: [
            { attributeId: "attack", role: "none", weightPct: 0 },
            { attributeId: "defense", role: "none", weightPct: 0 },
            { attributeId: "hp", role: "primary", weightPct: 100 },
            { attributeId: "speed", role: "none", weightPct: 0 },
          ],
        },
      ],
    };
    const result = computeGrowthProjection(trimmed, { anchors: [180] });
    const anchor = anchorOf(result, 180);
    const attack = attrOf(anchor, "attack").value;
    const rHero = 1 - Math.exp(-HERO_K.standard * 180);
    expect(attack).toBeCloseTo(100 + 4900 * rHero, 6);
    expect((5000 - attack) / 4900).toBeLessThan(0.02); // 渐近差 <2%
    expect(attack).toBeLessThan(5000); // hero 独占列故意不满级
    // hp 列全部来自 r=1 的线 → 精确 level_max
    expect(attrOf(anchor, "hp").value).toBeCloseTo(20000, 6);
  });

  it("属性列全 0（无任何线投放）→ 恒为 level_1 且仍出现在 attributes 输出", () => {
    const battle = makeBattleData();
    const noSpeed: ComputedBattleData = {
      ...battle,
      allocationMatrix: battle.allocationMatrix.map((row) => ({
        ...row,
        allocations: row.allocations.map((a) =>
          a.attributeId === "speed" ? { ...a, weightPct: 0, role: "none" as const } : a
        ),
      })),
    };
    const result = computeGrowthProjection(noSpeed, { anchors: [7, 180] });
    for (const anchor of result.anchors) {
      expect(attrOf(anchor, "speed").value).toBe(10); // level_1.SPD
    }
  });
});

// ==================== 线贡献归一约定 ====================

describe("computeGrowthProjection — 线贡献归一", () => {
  it("任一锚点 Σlines.power = totalPower（±0.5 浮点容差）", () => {
    const result = computeGrowthProjection(makeFullBattleData());
    for (const anchor of result.anchors) {
      const lineSum = anchor.lines.reduce((s, l) => s + l.power, 0);
      expect(Math.abs(lineSum - anchor.totalPower), `day=${anchor.day}`).toBeLessThan(0.5);
    }
  });

  it("totalPower 供给模型单调：r 单调 → 属性单调 → Power 随锚点严格递增", () => {
    const battle = makeBattleData();
    const result = computeGrowthProjection(battle, { anchors: [30, 90] });
    const p30 = anchorOf(result, 30).totalPower;
    const p90 = anchorOf(result, 90).totalPower;
    expect(p30).toBeGreaterThan(0);
    expect(p90).toBeGreaterThan(p30);
  });
});

// ==================== 装备线稀释真实可见 ====================

describe("computeGrowthProjection — 装备线稀释（6 装备全开）", () => {
  const result = computeGrowthProjection(makeFullBattleData(), { anchors: [90] });
  const anchor = anchorOf(result, 90);
  const equipLines = anchor.lines.filter((l) => l.type === "equipment");
  const hero = lineOf(anchor, "hero");

  it("单装备线 power < totalPower × 0.2（稀释上界：真实公式占比，非份额压缩）", () => {
    expect(equipLines).toHaveLength(6);
    for (const l of equipLines) {
      expect(l.power, l.id).toBeGreaterThan(0);
      expect(l.power / anchor.totalPower, l.id).toBeLessThan(0.2);
    }
  });

  it("装备合计占比 > hero 线占比（多线投放真实可见，供 P2-W1 power-overlap 消费）", () => {
    const equipTotal = equipLines.reduce((s, l) => s + l.power, 0);
    expect(equipTotal).toBeGreaterThan(hero.power);
  });
});

// ==================== 键名归一（大写键真链路） ====================

describe("computeGrowthProjection — 键名归一（intent 大写键 → 结构小写键）", () => {
  it("classic-4：growthTable 大写 ATK/DEF/HP/SPD 键经归一供给四维属性", () => {
    const battle = makeBattleData();
    const result = computeGrowthProjection(battle, { anchors: [30] });
    const anchor = anchorOf(result, 30);
    for (const key of ["attack", "defense", "hp", "speed"]) {
      const value = attrOf(anchor, key).value;
      expect(value, key).toBeCloseTo(expectedAttr(battle, key, 30), 6);
      expect(value, key).toBeGreaterThan(0);
    }
  });

  it("extended-6：大写 ATK 与小写 crit 混合键均被读取（crit 参与 power 计价）", () => {
    const battle = makeFullBattleData(); // extended-6：ATK/HP/crit + DEF/SPD/effect-hit
    const result = computeGrowthProjection(battle, { anchors: [90] });
    const anchor = anchorOf(result, 90);
    const crit = attrOf(anchor, "crit");
    expect(crit.value).toBeCloseTo(expectedAttr(battle, "crit", 90), 6);
    expect(crit.value).toBeGreaterThan(0);
    expect(crit.id).toBe("crit");
    // effect-hit 不参与 power 五键计价但供给值仍输出
    expect(attrOf(anchor, "effect-hit").value).toBeGreaterThan(0);
  });
});

// ==================== sharePct 语义升级（战力价值占比） ====================

describe("computeGrowthProjection — sharePct 战力价值占比", () => {
  it("ΣsharePct = 100%，且与 value×marginal 归一成比例（攻击价值占比显著）", () => {
    const result = computeGrowthProjection(makeBattleData(), { anchors: [90] });
    const anchor = anchorOf(result, 90);
    const shareSum = anchor.attributes.reduce((s, a) => s + a.sharePct, 0);
    expect(shareSum).toBeCloseTo(100, 6);
    // multiplicative 型下 attack 与 hp 为战力主轴，sharePct 应显著高于 speed
    const attack = attrOf(anchor, "attack");
    const speed = attrOf(anchor, "speed");
    expect(attack.sharePct).toBeGreaterThan(speed.sharePct);
  });
});

// ==================== allocationMatrix 行缺失线 ====================

describe("computeGrowthProjection — 行缺失线", () => {
  it("矩阵行缺失的线 → power=0 且标注未切分，其余线归一不受破坏", () => {
    const battle = makeBattleData();
    const trimmed = battle.allocationMatrix.filter((r) => r.growthLineId !== "equipment-helm");
    const broken = { ...battle, allocationMatrix: trimmed };
    const result = computeGrowthProjection(broken, { anchors: [7] });
    const anchor = anchorOf(result, 7);
    expect(lineOf(anchor, "equipment-helm").power).toBe(0);
    expect(lineOf(anchor, "equipment-helm").stage).toContain("未切分");
    const lineSum = anchor.lines.reduce((s, l) => s + l.power, 0);
    expect(Math.abs(lineSum - anchor.totalPower)).toBeLessThan(0.5);
    // 缺行线不参与供给：wp 分母不含 helm（attack 供给与删 helm 后期望一致）
    expect(attrOf(anchor, "attack").value).toBeCloseTo(expectedAttr(broken, "attack", 7), 6);
  });
});

// ==================== stage/progress 原始口径保留 ====================

describe("computeGrowthProjection — stage/progress 原始口径", () => {
  const result = computeGrowthProjection(makeFullBattleData());
  const anchor = anchorOf(result, 90);

  it("hero progress = 等级（渐近曲线）、equipment = 品质、skill/pet = 0-1 深度", () => {
    expect(lineOf(anchor, "hero").stage).toMatch(/^Lv\.\d+$/);
    const hero = lineOf(anchor, "hero");
    expect(hero.progress).toBeGreaterThan(30);
    // 50 级域（V8 W3-T3 缺省产物自描述）：r(90) = 1−e^(−2.25) ≈ 0.894601 → 50×r ≈ 44.73
    expect(hero.progress).toBeLessThanOrEqual(50);
    for (const l of anchor.lines.filter((x) => x.type === "equipment")) {
      expect(l.stage).toMatch(/^品质 \d+\.\d \+ 强化 \+\d+$/);
      expect(l.progress).toBeGreaterThan(1);
      expect(l.progress).toBeLessThanOrEqual(6);
    }
    expect(lineOf(anchor, "skill").progress).toBeGreaterThan(0);
    expect(lineOf(anchor, "skill").progress).toBeLessThanOrEqual(1);
    expect(lineOf(anchor, "pet").progress).toBeGreaterThan(0);
    expect(lineOf(anchor, "pet").progress).toBeLessThanOrEqual(1);
  });

  it("day=180 端点：hero 接近满级（渐近 <2% 差）、装备品质触顶且强化归零", () => {
    const last = anchorOf(result, 180);
    const hero = lineOf(last, "hero");
    // 50 级域：r(180) = 1−e^(−4.5) ≈ 0.988891 → 50×r ≈ 49.4446（端点 >49 ≤50，渐近差
    // 50−49.4446 ≈ 0.5554 < 50×0.02 = 1）
    expect(hero.progress).toBeGreaterThan(49);
    expect(hero.progress).toBeLessThanOrEqual(50);
    expect(50 - hero.progress).toBeLessThan(50 * 0.02);
    const weapon = lineOf(last, "equipment-weapon");
    expect(weapon.progress).toBeCloseTo(6, 10);
    expect(weapon.stage).toMatch(/强化 \+0$/);
  });
});

// ==================== pace 形变保留 ====================

describe("computeGrowthProjection — pace 形变（作用于进度率）", () => {
  const battle = makeBattleData();

  it("day=30：aggressive > standard > relaxed（属性供给单调 → Power 单调）", () => {
    const powers = (["aggressive", "standard", "relaxed"] as const).map((pace) =>
      anchorOf(computeGrowthProjection(battle, { anchors: [30], pace }), 30).totalPower
    );
    expect(powers[0]).toBeGreaterThan(powers[1]);
    expect(powers[1]).toBeGreaterThan(powers[2]);
  });

  it("hero 等级 / 装备品质进度速率随 pace 单调", () => {
    const lv = (pace: "aggressive" | "standard" | "relaxed") =>
      lineOf(anchorOf(computeGrowthProjection(battle, { anchors: [30], pace }), 30), "hero").progress;
    expect(lv("aggressive")).toBeGreaterThan(lv("standard"));
    expect(lv("standard")).toBeGreaterThan(lv("relaxed"));
  });

  it("day=180 各档属性供给收敛（equipment/skill/pet r=1 精确，仅 hero 渐近差）", () => {
    const battleStd = makeBattleData();
    const values = (["aggressive", "standard", "relaxed"] as const).map((pace) =>
      attrOf(anchorOf(computeGrowthProjection(battleStd, { anchors: [180], pace }), 180), "hp").value
    );
    // 三档 hp 差 <2%（hero 渐近速率差被 colShare 稀释，上限即 Spec 渐近容差）
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(values[0] * 0.02);
  });
});

// ==================== 确定性 ====================

describe("computeGrowthProjection — 确定性", () => {
  it("相同输入两次调用输出深度相等且非同一引用", () => {
    const battle = makeFullBattleData();
    const first = computeGrowthProjection(battle, { anchors: [7, 90] });
    const second = computeGrowthProjection(battle, { anchors: [7, 90] });
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.anchors[0].lines).not.toBe(second.anchors[0].lines);
  });

  it("不变异入参 battle confirmedData", () => {
    const battle = makeFullBattleData();
    const snapshot = JSON.parse(JSON.stringify(battle));
    computeGrowthProjection(battle);
    expect(battle).toEqual(snapshot);
  });
});

// ==================== 边界条件 ====================

describe("computeGrowthProjection — 边界条件", () => {
  it("空锚点数组 → 空 anchors，不抛错", () => {
    const result = computeGrowthProjection(makeBattleData(), { anchors: [] });
    expect(result.anchors).toEqual([]);
    expect(result.pace).toBe("standard");
  });

  it("锚点 day<1 被过滤（day 必须 ≥1）", () => {
    const result = computeGrowthProjection(makeBattleData(), { anchors: [0, 7, -3, 30] });
    expect(result.anchors.map((a) => a.day)).toEqual([7, 30]);
  });

  it("allocationMatrix 为空数组 → attributes 恒为 level_1 + lines 未切分（防御，不抛错）", () => {
    const broken = { ...makeBattleData(), allocationMatrix: [] } as ComputedBattleData;
    const result = computeGrowthProjection(broken, { anchors: [7] });
    const anchor = anchorOf(result, 7);
    for (const l of anchor.lines) {
      expect(l.power).toBe(0);
      expect(l.stage).toContain("未切分");
    }
    // 无投放来源 → 各属性恒 level_1
    expect(attrOf(anchor, "attack").value).toBe(100);
    expect(anchor.totalPower).toBeGreaterThan(0); // level_1 属性仍有基础战力
  });

  it("options 覆盖 heroMaxLevel / equipmentMaxQuality（stage 展示口径）", () => {
    const result = computeGrowthProjection(makeBattleData(), {
      anchors: [180],
      heroMaxLevel: 40,
      equipmentMaxQuality: 4,
    });
    const last = anchorOf(result, 180);
    expect(lineOf(last, "hero").progress).toBeLessThanOrEqual(40);
    expect(lineOf(last, "equipment-weapon").progress).toBeCloseTo(4, 10);
  });
});

// ==================== index 独立导出 ====================

describe("computeGrowthProjection — index 独立导出", () => {
  it("从 formula-engine 入口可导入（不进 computeFromIntent switch）", async () => {
    const index = await import("../index");
    expect(typeof index.computeGrowthProjection).toBe("function");
    expect(typeof index.computePowerStats).toBe("function");
    expect(typeof index.normalizeAttrKey).toBe("function");
    // growth-projection 是派生面板而非规划模块，不注册 intent 路由
    expect(() =>
      index.computeFromIntent({ moduleType: "growth-projection" } as never)
    ).toThrow();
  });
});

// ==================== V8 W2-T6b（R7）：lineWeight 线贡献爬坡 ====================

/**
 * S9b fixture：S9a SLG 调度经真实引擎产出（computeBattleFromIntent，非手造 echo）——
 * maxLevel=30，调度 hero@1 / equipment-weapon@5 / pet@15 + unlock[24,27,30]，
 * stages 恰 3 段（开荒/装备/宠物）→ derivedStageBounds=[5,15]（切点 = weapon/pet openAt）。
 * equipmentCategories=2 → growthLines = hero/weapon/armor/pet（armor 不在调度内 =
 * 「未声明 openAt 的线」边界样本）；biases 空 → 不写 stageMatrices（层 1 不混入，只测层 2）。
 */
function makeScheduledBattleData(): ComputedBattleData {
  const intent = makeBattleIntentOverrides({
    equipmentCategories: 2,
    petEnabled: true,
    skillDepth: "none",
    lineSchedule: {
      lines: {
        hero: { openAt: 1 },
        "equipment-weapon": { openAt: 5 },
        pet: { openAt: 15, unlockLevels: [24, 27, 30] },
      },
    },
    stageAllocation: {
      stages: [
        { name: "开荒期", focusLines: ["hero"] },
        { name: "装备期", focusLines: ["equipment-weapon"] },
        { name: "宠物期", focusLines: ["pet"] },
      ],
      biases: {},
    },
  });
  return computeBattleFromIntent({
    ...intent,
    anchors: { ...intent.anchors, maxLevel: 30 },
  });
}

/**
 * Review 修复（P1-B）fixture：仅声明 lineSchedule（无 stages）——stageFocus 不写键的
 * 边界样本；weapon openAt=6 故意取缺省切点 ⌈0.2×30⌉=6（巧合重合位，曾意外获 boost）。
 */
function makeScheduleOnlyBattleData(): ComputedBattleData {
  const intent = makeBattleIntentOverrides({
    equipmentCategories: 2,
    petEnabled: true,
    skillDepth: "none",
    lineSchedule: {
      lines: {
        hero: { openAt: 1 },
        "equipment-weapon": { openAt: 6 },
        pet: { openAt: 15 },
      },
    },
  });
  return computeBattleFromIntent({
    ...intent,
    anchors: { ...intent.anchors, maxLevel: 30 },
  });
}

describe("lineWeight — S9b 爬坡边界（确定性纯函数）", () => {
  const echo = makeScheduledBattleData().lineScheduleEcho!;

  it("fixture 前置：真实引擎产物 derivedStageBounds=[5,15]（stages 切点 = weapon@5 / pet@15）", () => {
    expect(echo.derivedStageBounds).toEqual([5, 15]);
  });

  it("pet 开放前零贡献：hero 等级 <15 恒 0（L < openAt → 0）", () => {
    for (const L of [1, 3, 5, 8, 14]) {
      expect(lineWeight("pet", L, echo), `L=${L}`).toBe(0);
    }
  });

  it("pet 15-20 线性渐入：爬坡分量 15→0、17→0.4、20→1（全权重 = 爬坡 × 宠物期 focus 1.5）", () => {
    // (15−15)/5 = 0（开放当级零贡献）
    expect(lineWeight("pet", 15, echo)).toBe(0);
    // 爬坡分量 (17−15)/5 = 0.4（Spec S9b 锚定值）；全权重 0.4 × 1.5 = 0.6
    expect(lineWeight("pet", 17, echo) / FOCUS_BOOST_DEFAULT).toBeCloseTo(
      (17 - 15) / RAMP_LEVELS,
      12
    );
    expect(lineWeight("pet", 17, echo)).toBeCloseTo(
      ((17 - 15) / RAMP_LEVELS) * FOCUS_BOOST_DEFAULT,
      12
    );
    // 爬坡分量 (20−15)/5 = 1；全权重 1 × 1.5 = 1.5
    expect(lineWeight("pet", 20, echo) / FOCUS_BOOST_DEFAULT).toBeCloseTo(1, 12);
    expect(lineWeight("pet", 20, echo)).toBeCloseTo(1.5, 12);
  });

  it("pet 24/27/30 unlock 档位阶跃：绝对乘子 ×1.2/×1.4/×1.6，档内平滑（台阶恒定）", () => {
    const w = (L: number) => lineWeight("pet", L, echo);
    // 基线（爬坡完成 × 宠物期 focus × 无越档）：1 × 1.5 × 1 = 1.5
    expect(w(23)).toBeCloseTo(1 * FOCUS_BOOST_DEFAULT * 1, 12);
    // 24 档：k=1 → ×(1+0.2×1)=1.2 → 1 × 1.5 × 1.2 = 1.8；跳升比 1.8/1.5 = 1.2
    expect(w(24)).toBeCloseTo(1 * FOCUS_BOOST_DEFAULT * (1 + UNLOCK_STEP_GAIN * 1), 12);
    expect(w(24) / w(23)).toBeCloseTo(1.2, 12);
    // 27 档：k=2 → ×(1+0.2×2)=1.4 → 1 × 1.5 × 1.4 = 2.1
    expect(w(27)).toBeCloseTo(1 * FOCUS_BOOST_DEFAULT * (1 + UNLOCK_STEP_GAIN * 2), 12);
    // 30 档：k=3 → ×(1+0.2×3)=1.6 → 1 × 1.5 × 1.6 = 2.4（三档全过 ×1.6 = Spec 量级锚定）
    expect(w(30)).toBeCloseTo(1 * FOCUS_BOOST_DEFAULT * (1 + UNLOCK_STEP_GAIN * 3), 12);
    // 档内平滑：档与档之间权重恒定（阶跃台阶，无斜坡）
    expect(w(25)).toBe(w(24)); // 24-26 档内恒 1.8
    expect(w(26)).toBe(w(24));
    expect(w(28)).toBe(w(27)); // 27-29 档内恒 2.1
    expect(w(29)).toBe(w(27));
  });

  it("Lv3 → hero 独占（weapon/pet 未开放）；Lv8 → hero 与 weapon 混合（weapon 爬坡 0.6 × 装备期 focus 1.5）", () => {
    // hero@1：开荒期 [1,5) focus（openAt 1 == 段起点 1）→ w(3) = (3−1)/5 × 1.5 = 0.6
    expect(lineWeight("hero", 3, echo)).toBeCloseTo(
      ((3 - 1) / RAMP_LEVELS) * FOCUS_BOOST_DEFAULT,
      12
    );
    // weapon/pet 开放前零贡献 → 调度线中 hero 独占
    expect(lineWeight("equipment-weapon", 3, echo)).toBe(0);
    expect(lineWeight("pet", 3, echo)).toBe(0);
    // weapon@5：Lv8 ∈ 装备期 [5,15) focus → w(8) = (8−5)/5 × 1.5 = 0.6 × 1.5 = 0.9（S9b 锚定）
    expect(lineWeight("equipment-weapon", 8, echo)).toBeCloseTo(
      ((8 - 5) / RAMP_LEVELS) * FOCUS_BOOST_DEFAULT,
      12
    );
    expect(lineWeight("equipment-weapon", 8, echo)).toBeCloseTo(0.9, 12);
    // hero Lv8：爬坡完成（8 ≥ 1+5）且不在 focus 段（[5,15) focus 是 weapon）→ 恰 1
    expect(lineWeight("hero", 8, echo)).toBe(1);
  });

  it("段边界切换：Lv5 起进入装备期（hero 失去 focus、weapon 获 focus 但开放当级爬坡 0）", () => {
    // hero Lv5：爬坡 (5−1)/5 = 0.8；段 [5,15) 非 hero focus → 0.8（不再 ×1.5）
    expect(lineWeight("hero", 5, echo)).toBeCloseTo((5 - 1) / RAMP_LEVELS, 12);
    // weapon Lv5：开放当级爬坡 (5−5)/5 = 0（× focus 1.5 仍为 0）
    expect(lineWeight("equipment-weapon", 5, echo)).toBe(0);
    // weapon Lv10：爬坡完成 × 装备期 focus = 1 × 1.5 = 1.5
    expect(lineWeight("equipment-weapon", 10, echo)).toBeCloseTo(1.5, 12);
    // weapon Lv16（宠物期 [15,∞) 非 focus、无 unlock 档）→ 恰 1
    expect(lineWeight("equipment-weapon", 16, echo)).toBe(1);
  });

  it("未声明 openAt 的线 = openAt 1（armor 不在调度内 → 与 hero 同起点爬坡，无 focus）", () => {
    // armor 缺省 openAt 1：w(3) = (3−1)/5 = 0.4——Review 修复（P1-B）：focusBoost 只认
    // stageFocus 显式映射（stages 恰 3 段），armor 不在任何段的 focusLines → 无 ×1.5
    //（旧「openAt == 段起点」巧合等价曾使未声明线意外获 boost，与 FOCUS_BOOST_DEFAULT
    //  docstring「无 stages 声明时无 focus 放大」矛盾，已废弃）
    expect(lineWeight("equipment-armor", 3, echo)).toBeCloseTo(
      (3 - 1) / RAMP_LEVELS,
      12
    );
    // Lv6 爬坡完成（6 ≥ 1+5）、非任何段 focus → 恰 1
    expect(lineWeight("equipment-armor", 6, echo)).toBe(1);
  });

  it("Review 修复（P1-B）：无 stages → stageFocus 不写键，任何线无 focus boost（含 openAt 与缺省切点重合）", () => {
    const echoOnly = makeScheduleOnlyBattleData().lineScheduleEcho!;
    expect("stageFocus" in echoOnly).toBe(false);
    // hero 缺省 openAt 1（曾因 == 首段起点巧合 ×1.5）→ 仅爬坡 (3−1)/5 = 0.4
    expect(lineWeight("hero", 3, echoOnly)).toBeCloseTo((3 - 1) / RAMP_LEVELS, 12);
    // weapon openAt 6 == 缺省切点 ⌈0.2×30⌉=6（曾巧合获 boost）→ 仅爬坡 (10−6)/5 = 0.8
    expect(lineWeight("equipment-weapon", 10, echoOnly)).toBeCloseTo(
      (10 - 6) / RAMP_LEVELS,
      12
    );
    // pet@15：爬坡完成后无放大（中段 focus 语义不存在）→ 恰 1
    expect(lineWeight("pet", 20, echoOnly)).toBeCloseTo(1, 12);
  });

  it("无调度 → w 恒 1（缺省恒等，S1）", () => {
    expect(lineWeight("hero", 1, undefined)).toBe(1);
    expect(lineWeight("pet", 15, undefined)).toBe(1);
    expect(lineWeight("equipment-weapon", 8, undefined)).toBe(1);
  });
});

describe("computeGrowthProjection — R7 线调度注入（L 口径 = hero 主线等级）", () => {
  /**
   * heroL(day) = clamp(⌈(1−e^(−0.025·day))×30⌉, 1, 30)（r_hero = 现有 hero 渐近曲线）：
   * day=1 → ⌈0.02469×30⌉=1；day=7 → ⌈0.16054×30⌉=5；day=20 → ⌈0.39347×30⌉=12；
   * day=30 → ⌈0.52763×30⌉=16；day=180 → ⌈0.98914×30⌉=30。
   */
  it("pet 线贡献在 hero 等级 <15 时恒 0（day=7→heroL5、day=20→heroL12）；day=30（heroL16）转正", () => {
    const result = computeGrowthProjection(makeScheduledBattleData(), {
      anchors: [7, 20, 30],
      heroMaxLevel: 30,
    });
    expect(lineOf(anchorOf(result, 7), "pet").power).toBe(0);
    expect(lineOf(anchorOf(result, 20), "pet").power).toBe(0);
    // heroL=16 → pet w = (16−15)/5 × 1.5 = 0.3 > 0（pet 深度 r(30)=ln30/ln180≈0.655 > 0）
    expect(lineOf(anchorOf(result, 30), "pet").power).toBeGreaterThan(0);
  });

  it("day=1 边界：heroL=1 → 全线权重 0（爬坡起点），线贡献全 0 不 NaN，基础战力仍在", () => {
    const result = computeGrowthProjection(makeScheduledBattleData(), {
      anchors: [1],
      heroMaxLevel: 30,
    });
    const anchor = result.anchors[0];
    for (const l of anchor.lines) {
      expect(l.power, l.id).toBe(0); // hero w(1)=(1−1)/5=0；weapon/pet 未开放；armor@1 同为 0
    }
    expect(anchor.totalPower).toBeGreaterThan(0); // 加权全 0 → 属性恒 level_1 仍有战力
  });

  it("线间归一：各 day 线贡献占比合计 = 100%（±1e-9）", () => {
    const result = computeGrowthProjection(makeScheduledBattleData(), { heroMaxLevel: 30 });
    expect(result.anchors.length).toBeGreaterThan(0);
    for (const anchor of result.anchors) {
      const shareSum = anchor.lines.reduce((s, l) => s + l.power / anchor.totalPower, 0);
      expect(Math.abs(shareSum - 1), `day=${anchor.day}`).toBeLessThan(1e-9);
    }
  });

  it("恒等对照：剥去 lineScheduleEcho → 线权重不再注入（pet 早期照常参与，总盘与有 echo 分流）", () => {
    const battle = makeScheduledBattleData();
    const { lineScheduleEcho: stripped, ...echoFree } = battle;
    void stripped;
    const withEcho = computeGrowthProjection(battle, { anchors: [20], heroMaxLevel: 30 });
    const without = computeGrowthProjection(echoFree as ComputedBattleData, {
      anchors: [20],
      heroMaxLevel: 30,
    });
    // 有 echo（heroL=12 < 15）→ pet 0；无 echo → pet 按现行为参与（>0）
    expect(lineOf(anchorOf(withEcho, 20), "pet").power).toBe(0);
    expect(lineOf(anchorOf(without, 20), "pet").power).toBeGreaterThan(0);
    // 无 echo 路径与现行为一致由本文件既有全部测试零迁移钉死；此处验证两路径确实分流
    expect(withEcho.anchors[0].totalPower).not.toBeCloseTo(without.anchors[0].totalPower, 6);
  });

  it("Review 修复（P1-A 同源契约）：lineSchedule 声明时 powerProfile.power = 投影末锚 totalPower（±0.5）", () => {
    // 两路径同缺省口径（standard pace + 产物自描述 heroMaxLevel=30，V8 W3-T3 起两
    // 消费位同源）——battle.ts 的 powerProfile base 携带 lineScheduleEcho，经
    // computePowerAtDay 消费同调度权重（曾分裂 28.6%）
    const battle = makeScheduledBattleData();
    const projection = computeGrowthProjection(battle, { anchors: [180] });
    const last = projection.anchors[projection.anchors.length - 1];
    expect(Math.abs(battle.powerProfile.power - last.totalPower)).toBeLessThan(0.5);
  });

  it("Review 修复（P1-C 供给上界）：按列权重Σ clamp ≤1 → 投影属性不突破成长表满级锚", () => {
    const battle = makeScheduledBattleData();
    const projection = computeGrowthProjection(battle, {
      anchors: [180],
      heroMaxLevel: 30,
    });
    const anchor = anchorOf(projection, 180);
    // 成长表列 = 设计键（ATK…），attributes id = 归一键（attack…）——normalizeAttrKey 对齐
    const lvMaxBy = new Map<string, number>();
    for (const [k, v] of Object.entries(
      battle.attributeGrowthTable[battle.attributeGrowthTable.length - 1]
    )) {
      if (k !== "level") lvMaxBy.set(normalizeAttrKey(k), v as number);
    }
    for (const a of anchor.attributes) {
      // 成长表满级锚 = 设计真源：权重语义是加速触达上限，不是突破设计
      expect(lvMaxBy.has(a.id), a.id).toBe(true);
      expect(a.value, a.id).toBeLessThanOrEqual(lvMaxBy.get(a.id)! + 1e-9);
    }
    // 曾越锚的列（defense +17.6% / hp +57.8%，Review 实测）现恰触上限
    const defense = anchor.attributes.find((a) => a.id === "defense");
    const hp = anchor.attributes.find((a) => a.id === "hp");
    expect(defense!.value).toBe(lvMaxBy.get("defense"));
    expect(hp!.value).toBe(lvMaxBy.get("hp"));
  });
});

// ==================== heroMaxLevel 缺省产物自描述（V8 W3-T3） ====================

describe("computeGrowthProjection — heroMaxLevel 缺省产物自描述（V8 W3-T3）", () => {
  /** 60 级产物 fixture（makeBattleIntentOverrides 同构，仅 anchors.maxLevel=60） */
  function makeLevel60BattleData(): ComputedBattleData {
    const intent = makeBattleIntentOverrides();
    return computeBattleFromIntent({ ...intent, anchors: { ...intent.anchors, maxLevel: 60 } });
  }

  it("缺省改：50 级产物不传 heroMaxLevel → hero 轴 50 域，与显式 heroMaxLevel:50 深度相等", () => {
    // r = 1 − e^(−0.025×180) = 1 − e^(−4.5) ≈ 0.988891 → 50×r ≈ 49.4446（50 域端点）
    const battle = makeBattleData(); // fixture maxLevel=50 → growthTable 末行 level=50
    const result = computeGrowthProjection(battle, { anchors: [180] });
    const hero = lineOf(anchorOf(result, 180), "hero");
    expect(hero.progress).toBeCloseTo(50 * (1 - Math.exp(-HERO_K.standard * 180)), 10);
    expect(hero.stage).toBe(`Lv.${Math.round(50 * (1 - Math.exp(-HERO_K.standard * 180)))}`);
    expect(result).toEqual(computeGrowthProjection(battle, { anchors: [180], heroMaxLevel: 50 }));
  });

  it("回退：growthTable 末行无自描述 level → 60 域保持（向后兼容旧产物）", () => {
    const source = makeBattleData();
    const table = source.attributeGrowthTable;
    const noSelfLevel: ComputedBattleData = {
      ...source,
      attributeGrowthTable: table.map((row, i) =>
        i === table.length - 1
          ? Object.fromEntries(Object.entries(row).filter(([k]) => k !== "level"))
          : row
      ),
    };
    const result = computeGrowthProjection(noSelfLevel, { anchors: [180] });
    const hero = lineOf(anchorOf(result, 180), "hero");
    // r ≈ 0.988891 → 60×r ≈ 59.3335（60 域回退）
    expect(hero.progress).toBeCloseTo(60 * (1 - Math.exp(-HERO_K.standard * 180)), 10);
    // 数值口径不受缺省影响：属性/战力与原产物（有自描述）逐项一致（无调度 → 权重恒 1）
    const withSelf = computeGrowthProjection(source, { anchors: [180] });
    expect(anchorOf(result, 180).attributes).toEqual(anchorOf(withSelf, 180).attributes);
    expect(anchorOf(result, 180).totalPower).toBe(anchorOf(withSelf, 180).totalPower);
  });

  it("S1 恒等（数值口径）：60 级 fixture 产物缺省推演 attrs/power 零变化", () => {
    const battle = makeLevel60BattleData();
    const def = computeGrowthProjection(battle, { anchors: [90] });
    // 自描述 60 与显式 60 全等（含 hero 线展示口径）
    expect(def).toEqual(computeGrowthProjection(battle, { anchors: [90], heroMaxLevel: 60 }));
    // 无调度时 heroMaxLevel 不参与 attrs/power：任意 what-if 上限不改变数值口径
    const alt = computeGrowthProjection(battle, { anchors: [90], heroMaxLevel: 77 });
    expect(anchorOf(def, 90).attributes).toEqual(anchorOf(alt, 90).attributes);
    expect(anchorOf(def, 90).totalPower).toBe(anchorOf(alt, 90).totalPower);
    // hero 线展示口径仍 60 域：r = 1 − e^(−2.25) ≈ 0.894601 → 60×r ≈ 53.676
    expect(lineOf(anchorOf(def, 90), "hero").progress).toBeCloseTo(
      60 * (1 - Math.exp(-HERO_K.standard * 90)),
      10
    );
  });

  it("computePowerAtDay 消费位同源：缺省 = 产物自描述（30 级调度产物 heroL 30 域），≠ 60 域", () => {
    const battle = makeScheduledBattleData(); // maxLevel=30 + lineScheduleEcho → R7 权重参与
    // day=180：30 域 heroL=30 与 60 域 heroL=60 同落调度饱和区（unlock 三档全过 +
    // late 段 + 爬坡完成）→ 权重相同，验证同源一致性
    const def180 = computePowerAtDay(battle, 180);
    expect(def180.stats).toEqual(computePowerAtDay(battle, 180, { heroMaxLevel: 30 }).stats);
    // day=7 分叉锐度：r = 1 − e^(−0.175) ≈ 0.160540 → 30 域 heroL=⌈4.816⌉=5（weapon
    // 爬坡 (5−5)/5=0）vs 60 域 heroL=⌈9.632⌉=10（weapon 爬坡完成 ×1.5）→ 战力分叉
    const def7 = computePowerAtDay(battle, 7);
    const at30_7 = computePowerAtDay(battle, 7, { heroMaxLevel: 30 });
    const at60_7 = computePowerAtDay(battle, 7, { heroMaxLevel: 60 });
    expect(def7.attrs).toEqual(at30_7.attrs);
    expect(def7.stats).toEqual(at30_7.stats);
    expect(def7.stats.power).not.toBe(at60_7.stats.power); // 曾全局缺省 60 静默分叉的修复点
  });
});
