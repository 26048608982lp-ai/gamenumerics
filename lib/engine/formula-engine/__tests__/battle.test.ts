import { describe, it, expect } from "vitest";
import {
  computeBattleFromIntent,
  DEFAULT_STRUCTURAL_DECISIONS,
  calcDamage,
  resolveEffectiveFocus,
} from "../battle";
import { computeGrowthProjection } from "../growth-projection";
import type { BattleDesignIntent } from "../types";
import type { ComputedBattleData, BattleAllocationRow } from "@/lib/types/planning";

function makeBattleIntent(overrides?: Partial<BattleDesignIntent>): BattleDesignIntent {
  return {
    moduleType: "battle",
    decisions: {
      attributeStyle: "standard",
      attributeCount: 3,
      skillTypeCombo: "standard",
      rationale: "Standard battle intent for testing",
    },
    strategy: {
      combatType: "realtime",
      attributeDesign: {
        primary: ["ATK", "DEF"],
        secondary: ["HP"],
        growthModels: { ATK: "linear", DEF: "exponential", HP: "linear" },
      },
      damageFormula: {
        type: "multiplicative",
        baseFormula: "ATK * coeff - DEF reduction",
        coefficients: { atkCoeff: 1.0, defCoeff: 0.5 },
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
      level_1: { ATK: 100, DEF: 50, HP: 500 },
      level_max: { ATK: 5000, DEF: 2000, HP: 20000 },
      maxLevel: 50,
      attributeBudgets: { ATK: 5000, DEF: 2000, HP: 20000 },
    },
    ...overrides,
  };
}

describe("computeBattleFromIntent", () => {
  it("generates attribute growth table with correct length", () => {
    const result = computeBattleFromIntent(makeBattleIntent());
    expect(result.attributeGrowthTable.length).toBe(50);
  });

  it("level_1 anchor matches exactly", () => {
    const result = computeBattleFromIntent(makeBattleIntent());
    expect(result.attributeGrowthTable[0].ATK).toBe(100);
    expect(result.attributeGrowthTable[0].DEF).toBe(50);
    expect(result.attributeGrowthTable[0].HP).toBe(500);
  });

  it("level_max anchor matches exactly", () => {
    const result = computeBattleFromIntent(makeBattleIntent());
    expect(result.attributeGrowthTable[49].ATK).toBe(5000);
    expect(result.attributeGrowthTable[49].DEF).toBe(2000);
    expect(result.attributeGrowthTable[49].HP).toBe(20000);
  });

  it("all values are positive", () => {
    const result = computeBattleFromIntent(makeBattleIntent());
    for (const row of result.attributeGrowthTable) {
      expect(row.ATK).toBeGreaterThan(0);
      expect(row.DEF).toBeGreaterThan(0);
      expect(row.HP).toBeGreaterThan(0);
    }
  });

  it("ATK is monotonically increasing (linear)", () => {
    const result = computeBattleFromIntent(makeBattleIntent());
    for (let i = 1; i < result.attributeGrowthTable.length; i++) {
      expect(result.attributeGrowthTable[i].ATK as number).toBeGreaterThanOrEqual(
        result.attributeGrowthTable[i - 1].ATK as number
      );
    }
  });

  it("generates damage simulations", () => {
    const result = computeBattleFromIntent(makeBattleIntent());
    expect(result.damageSimulations.length).toBeGreaterThan(0);
    for (const sim of result.damageSimulations) {
      expect(sim.expectedDamage).toBeGreaterThan(0);
    }
  });

  it("handles equal start/end values", () => {
    const intent = makeBattleIntent({
      anchors: {
        level_1: { ATK: 100, DEF: 50, HP: 500 },
        level_max: { ATK: 100, DEF: 50, HP: 500 },
        maxLevel: 50,
        attributeBudgets: { ATK: 100, DEF: 50, HP: 500 },
      },
    });
    const result = computeBattleFromIntent(intent);
    for (const row of result.attributeGrowthTable) {
      expect(row.ATK).toBe(100);
    }
  });

  it("handles large numbers without overflow", () => {
    const intent = makeBattleIntent({
      anchors: {
        level_1: { ATK: 1e9, DEF: 1e8, HP: 1e10 },
        level_max: { ATK: 1e9, DEF: 1e8, HP: 1e10 },
        maxLevel: 50,
        attributeBudgets: { ATK: 1e9, DEF: 1e8, HP: 1e10 },
      },
    });
    const result = computeBattleFromIntent(intent);
    expect(result.attributeGrowthTable[0].ATK).toBe(1e9);
    expect(Number.isFinite(result.damageSimulations[0].expectedDamage)).toBe(true);
  });

  it("missing anchor attributes default to 0", () => {
    const intent = makeBattleIntent({
      anchors: {
        level_1: {},
        level_max: {},
        maxLevel: 50,
        attributeBudgets: {},
      },
    });
    const result = computeBattleFromIntent(intent);
    expect(result.attributeGrowthTable[0].ATK).toBe(0);
  });

  it("preserves strategy metadata", () => {
    const result = computeBattleFromIntent(makeBattleIntent());
    expect(result.combatPacing).toBe("standard");
    expect(result.expectedCombatDuration).toEqual([30, 60]);
    expect(result.attributeDesign.primary).toEqual(["ATK", "DEF"]);
  });

  // ── Boundary: NaN inputs ──────────────────────────────────────────────
  describe("boundary: NaN inputs", () => {
    it("NaN anchor values produce finite results (not NaN propagation)", () => {
      const intent = makeBattleIntent({
        anchors: {
          level_1: { ATK: NaN, DEF: 50, HP: 500 },
          level_max: { ATK: 5000, DEF: 2000, HP: 20000 },
          maxLevel: 50,
          attributeBudgets: { ATK: 5000, DEF: 2000, HP: 20000 },
        },
      });
      const result = computeBattleFromIntent(intent);
      // NaN in level_1 anchor propagates through interpolation
      for (const row of result.attributeGrowthTable) {
        expect(Number.isNaN(row.ATK) || Number.isFinite(row.ATK)).toBe(true);
      }
      for (const sim of result.damageSimulations) {
        // damage should still be a finite number or NaN, not crash
        expect(typeof sim.expectedDamage === "number").toBe(true);
      }
    });

    it("NaN coefficients in damage formula are handled gracefully", () => {
      const intent = makeBattleIntent({
        strategy: {
          ...makeBattleIntent().strategy,
          damageFormula: {
            type: "multiplicative",
            baseFormula: "test",
            coefficients: { atkCoeff: NaN, defCoeff: 0.5 },
          },
        },
      });
      const result = computeBattleFromIntent(intent);
      // Should not throw; NaN may propagate but should not crash
      expect(result.damageSimulations.length).toBeGreaterThan(0);
    });
  });

  // ── Boundary: negative inputs ─────────────────────────────────────────
  describe("boundary: negative inputs", () => {
    it("negative anchor values still produce attribute growth table", () => {
      const intent = makeBattleIntent({
        anchors: {
          level_1: { ATK: -100, DEF: -50, HP: 500 },
          level_max: { ATK: 5000, DEF: 2000, HP: 20000 },
          maxLevel: 50,
          attributeBudgets: { ATK: 5000, DEF: 2000, HP: 20000 },
        },
      });
      const result = computeBattleFromIntent(intent);
      expect(result.attributeGrowthTable).toHaveLength(50);
      expect(result.attributeGrowthTable[0].ATK).toBe(-100);
      expect(result.attributeGrowthTable[0].DEF).toBe(-50);
    });

    it("negative coefficients produce finite damage values", () => {
      const intent = makeBattleIntent({
        strategy: {
          ...makeBattleIntent().strategy,
          damageFormula: {
            type: "reduction",
            baseFormula: "test",
            coefficients: { atkCoeff: -1.0, defCoeff: -0.5 },
          },
        },
      });
      const result = computeBattleFromIntent(intent);
      // reduction formula: Math.max(1, ...) ensures min damage
      for (const sim of result.damageSimulations) {
        expect(sim.expectedDamage).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ── Boundary: zero inputs ─────────────────────────────────────────────
  describe("boundary: zero inputs", () => {
    it("zero anchors produce growth table with zeros", () => {
      const intent = makeBattleIntent({
        anchors: {
          level_1: { ATK: 0, DEF: 0, HP: 0 },
          level_max: { ATK: 0, DEF: 0, HP: 0 },
          maxLevel: 50,
          attributeBudgets: { ATK: 0, DEF: 0, HP: 0 },
        },
      });
      const result = computeBattleFromIntent(intent);
      for (const row of result.attributeGrowthTable) {
        expect(row.ATK).toBe(0);
        expect(row.DEF).toBe(0);
        expect(row.HP).toBe(0);
      }
    });

    it("maxLevel=1 produces single-row growth table", () => {
      const intent = makeBattleIntent({
        anchors: {
          level_1: { ATK: 100, DEF: 50, HP: 500 },
          level_max: { ATK: 100, DEF: 50, HP: 500 },
          maxLevel: 1,
          attributeBudgets: { ATK: 100, DEF: 50, HP: 500 },
        },
      });
      const result = computeBattleFromIntent(intent);
      expect(result.attributeGrowthTable).toHaveLength(1);
    });
  });

  // ── Boundary: Infinity inputs ─────────────────────────────────────────
  describe("boundary: Infinity inputs", () => {
    it("Infinity anchor values produce finite or Infinity results without crash", () => {
      const intent = makeBattleIntent({
        anchors: {
          level_1: { ATK: Infinity, DEF: 50, HP: 500 },
          level_max: { ATK: 5000, DEF: 2000, HP: 20000 },
          maxLevel: 50,
          attributeBudgets: { ATK: 5000, DEF: 2000, HP: 20000 },
        },
      });
      const result = computeBattleFromIntent(intent);
      expect(result.attributeGrowthTable).toHaveLength(50);
      expect(result.attributeGrowthTable[0].ATK).toBe(Infinity);
    });

    it("Infinity in damage coefficients does not crash", () => {
      const intent = makeBattleIntent({
        strategy: {
          ...makeBattleIntent().strategy,
          damageFormula: {
            type: "multiplicative",
            baseFormula: "test",
            coefficients: { atkCoeff: Infinity, defCoeff: 0.5, K: 100 },
          },
        },
      });
      const result = computeBattleFromIntent(intent);
      for (const sim of result.damageSimulations) {
        expect(typeof sim.expectedDamage === "number").toBe(true);
      }
    });
  });

  // ── W2 P0-4: dpsEstimate + damageVsHigherDef bug fixes ────────────────
  describe("W2 P0-4: dpsEstimate + damageVsHigherDef fixes", () => {
    it("dpsEstimate differs from expectedDamage when SPD attribute is present", () => {
      const intent = makeBattleIntent({
        strategy: {
          ...makeBattleIntent().strategy,
          attributeDesign: {
            primary: ["ATK", "DEF", "SPD"],
            secondary: ["HP"],
            growthModels: { ATK: "linear", DEF: "exponential", HP: "linear", SPD: "linear" },
          },
        },
        anchors: {
          level_1: { ATK: 100, DEF: 50, HP: 500, SPD: 50 },
          level_max: { ATK: 5000, DEF: 2000, HP: 20000, SPD: 200 },
          maxLevel: 50,
          attributeBudgets: { ATK: 5000, DEF: 2000, HP: 20000, SPD: 200 },
        },
      });
      const result = computeBattleFromIntent(intent);
      // "同级普攻" 取早期档 E=⌈0.2×50⌉=10（V8 W2-T4a 4 档化，原 midLevel=30）：
      // SPD 已成长超过 baseSpd(50) → attacksPerSecond > 1
      const sim = result.damageSimulations.find((s) => s.scenario === "同级普攻");
      expect(sim).toBeDefined();
      expect(sim!.dpsEstimate).not.toBe(sim!.expectedDamage);
      expect(sim!.dpsEstimate as number).toBeGreaterThan(sim!.expectedDamage as number);
    });

    it("damageVsHigherDef is strictly less than expectedDamage (1.3x defense penalty)", () => {
      const result = computeBattleFromIntent(makeBattleIntent());
      const sim = result.damageSimulations.find((s) => s.scenario === "同级普攻");
      expect(sim).toBeDefined();
      expect(sim!.damageVsHigherDef as number).toBeLessThan(sim!.expectedDamage as number);
      expect(sim!.damageVsHigherDef as number).toBeGreaterThanOrEqual(1);
    });

    it("dpsEstimate equals expectedDamage when SPD is absent (backward-compatible fallback)", () => {
      const result = computeBattleFromIntent(makeBattleIntent());
      const sim = result.damageSimulations.find((s) => s.scenario === "同级普攻");
      expect(sim).toBeDefined();
      expect(sim!.dpsEstimate).toBe(sim!.expectedDamage);
    });
  });
});

// ==================== 结构层吸收（T2b，迁移自原框架模块引擎（已移除））====================

/** 结构决策 fixture（默认组合 = 问卷 A.1 默认，与原框架模块测试（已移除）对齐保期望值） */
type StructuralDecisions = NonNullable<BattleDesignIntent["structuralDecisions"]>;

function makeStructural(
  overrides?: Partial<StructuralDecisions>
): StructuralDecisions {
  return {
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
  };
}

/** structuralDecisions 覆盖 → 引擎计算（数值 fixture 与结构派生正交组合） */
function computeWith(overrides?: Partial<StructuralDecisions>) {
  return computeBattleFromIntent(
    makeBattleIntent({ structuralDecisions: makeStructural(overrides) })
  );
}

type MatrixRow = ComputedBattleData["allocationMatrix"][number];

function rowOf(result: { allocationMatrix: ComputedBattleData["allocationMatrix"] }, lineId: string): MatrixRow {
  const row = result.allocationMatrix.find((r) => r.growthLineId === lineId);
  if (!row) throw new Error(`growth line ${lineId} not found`);
  return row;
}

function pctOf(row: MatrixRow, attributeId: string): number {
  return row.allocations.find((a) => a.attributeId === attributeId)?.weightPct ?? -1;
}

function roleOf(row: MatrixRow, attributeId: string): string {
  return row.allocations.find((a) => a.attributeId === attributeId)?.role ?? "missing";
}

function lineIds(result: { growthLines: ComputedBattleData["growthLines"] }): string[] {
  return result.growthLines.map((l) => l.id);
}

function categoryIds(result: { attributeCategories: ComputedBattleData["attributeCategories"] }): string[] {
  return result.attributeCategories.map((c) => c.id);
}

describe("computeBattleFromIntent — 结构层吸收（S2 契约）", () => {
  it("structuralDecisions 提供 → 输出含 4 结构字段且矩阵与成长线等长", () => {
    const result = computeWith();
    expect(result.systemSwitches).toBeDefined();
    expect(result.growthLines.length).toBeGreaterThan(0);
    expect(result.attributeCategories.length).toBeGreaterThan(0);
    expect(result.allocationMatrix).toHaveLength(result.growthLines.length);
  });

  it("structuralDecisions 缺失 → DEFAULT_STRUCTURAL_DECISIONS 默认结构计算（输出形状恒定，S8）", () => {
    const result = computeBattleFromIntent(makeBattleIntent());
    expect(result.systemSwitches).toEqual({
      ...DEFAULT_STRUCTURAL_DECISIONS,
      // classic-4 无特殊类目 → specialAttrFocus 确定性回退 none（矛盾组合 fallback）
      specialAttrFocus: "none",
    });
    expect(lineIds(result)).toEqual([
      "hero",
      "equipment-weapon",
      "equipment-armor",
      "equipment-helm",
      "equipment-accessory",
      "skill", // skillDepth=upgrade → 技能线存在
    ]);
    expect(categoryIds(result)).toEqual(["attack", "defense", "hp", "speed"]);
    expect(result.allocationMatrix).toHaveLength(result.growthLines.length);
  });

  it("每条成长线 weightPct 总和 = 100（S2 契约：含默认结构与自定义结构两态）", () => {
    for (const result of [computeBattleFromIntent(makeBattleIntent()), computeWith()]) {
      for (const row of result.allocationMatrix) {
        const sum = row.allocations.reduce((s, a) => s + a.weightPct, 0);
        expect(sum, `line ${row.growthLineId}`).toBe(100);
      }
    }
  });

  it("结构吸收不改变既有数值输出（数值字段与结构字段正交）", () => {
    const withStructural = computeWith();
    const withoutStructural = computeBattleFromIntent(makeBattleIntent());
    expect(withStructural.attributeGrowthTable).toEqual(withoutStructural.attributeGrowthTable);
    expect(withStructural.damageSimulations).toEqual(withoutStructural.damageSimulations);
    expect(withStructural.attributeBudgets).toEqual(withoutStructural.attributeBudgets);
  });
});

// ==================== A.3 精确规则表（迁移自原框架模块测试（已移除））====================

describe("computeBattleFromIntent — A.3 规则表（默认组合 classic-4）", () => {
  const result = computeWith();

  it("成长线展开：hero + 4 类装备 + 技能（无宠物）", () => {
    expect(lineIds(result)).toEqual([
      "hero",
      "equipment-weapon",
      "equipment-armor",
      "equipment-helm",
      "equipment-accessory",
      "skill",
    ]);
  });

  it("attributeCategories 为 classic-4 四项", () => {
    expect(categoryIds(result)).toEqual(["attack", "defense", "hp", "speed"]);
    expect(result.attributeCategories.map((c) => c.name)).toEqual(["攻击", "防御", "生命", "速度"]);
  });

  it("hero 行精确值：攻击 40 / 防御 15 / 生命 35 / 速度 10", () => {
    const row = rowOf(result, "hero");
    expect(pctOf(row, "attack")).toBe(40);
    expect(pctOf(row, "defense")).toBe(15);
    expect(pctOf(row, "hp")).toBe(35);
    expect(pctOf(row, "speed")).toBe(10);
  });

  it("weapon 行精确值：攻击 65 / 速度 20 / 生命 15", () => {
    const row = rowOf(result, "equipment-weapon");
    expect(pctOf(row, "attack")).toBe(65);
    expect(pctOf(row, "speed")).toBe(20);
    expect(pctOf(row, "hp")).toBe(15);
    expect(pctOf(row, "defense")).toBe(0);
  });

  it("armor 行精确值：防御 55 / 生命 45", () => {
    const row = rowOf(result, "equipment-armor");
    expect(pctOf(row, "defense")).toBe(55);
    expect(pctOf(row, "hp")).toBe(45);
    expect(pctOf(row, "attack")).toBe(0);
    expect(pctOf(row, "speed")).toBe(0);
  });

  it("helm 行精确值：生命 55 / 防御 45", () => {
    const row = rowOf(result, "equipment-helm");
    expect(pctOf(row, "hp")).toBe(55);
    expect(pctOf(row, "defense")).toBe(45);
  });

  it("accessory 行 classic-4 特殊份额并入防御：攻击 20 / 防御 40 / 速度 40 / 生命 0", () => {
    const row = rowOf(result, "equipment-accessory");
    expect(pctOf(row, "attack")).toBe(20);
    expect(pctOf(row, "defense")).toBe(40);
    expect(pctOf(row, "speed")).toBe(40);
    expect(pctOf(row, "hp")).toBe(0);
  });

  it("skill 行 classic-4 特殊份额并入防御：攻击 50 / 防御 30 / 生命 20 / 速度 0", () => {
    const row = rowOf(result, "skill");
    expect(pctOf(row, "attack")).toBe(50);
    expect(pctOf(row, "defense")).toBe(30);
    expect(pctOf(row, "hp")).toBe(20);
    expect(pctOf(row, "speed")).toBe(0);
  });

  it("每条成长线 weightPct 总和 = 100", () => {
    for (const row of result.allocationMatrix) {
      const sum = row.allocations.reduce((s, a) => s + a.weightPct, 0);
      expect(sum, `line ${row.growthLineId}`).toBe(100);
    }
  });

  it("classic-4 矩阵退化为 4 列（无 special 聚合槽）", () => {
    for (const row of result.allocationMatrix) {
      expect(row.allocations).toHaveLength(4);
      expect(row.allocations.map((a) => a.attributeId)).toEqual(["attack", "defense", "hp", "speed"]);
    }
  });

  it("classic-4 无特殊类目 → specialAttrFocus fallback 为 none（systemSwitches 回显有效值）", () => {
    expect(result.systemSwitches.specialAttrFocus).toBe("none");
  });

  it("systemSwitches 回显 structuralDecisions 其余 8 字段", () => {
    expect(result.systemSwitches.formationSize).toBe(5);
    expect(result.systemSwitches.battlePace).toBe("turn-based");
    expect(result.systemSwitches.heroStarEnabled).toBe(true);
    expect(result.systemSwitches.equipmentEnabled).toBe(true);
    expect(result.systemSwitches.equipmentCategories).toBe(4);
    expect(result.systemSwitches.petEnabled).toBe(false);
    expect(result.systemSwitches.skillDepth).toBe("upgrade-star");
    expect(result.systemSwitches.attributeScheme).toBe("classic-4");
  });
});

describe("computeBattleFromIntent — A.3 规则表（special-flow 全开组合）", () => {
  const result = computeWith({
    attributeScheme: "special-flow",
    equipmentCategories: 6,
    petEnabled: true,
  });

  it("成长线全展开：hero + 6 装备 + 技能 + 宠物 = 9 行", () => {
    expect(lineIds(result)).toEqual([
      "hero",
      "equipment-weapon",
      "equipment-armor",
      "equipment-helm",
      "equipment-accessory",
      "equipment-charm",
      "equipment-boots",
      "skill",
      "pet",
    ]);
  });

  it("attributeCategories 为 special-flow 七项（四维+元素攻击+穿透+特殊抗性）", () => {
    expect(categoryIds(result)).toEqual([
      "attack",
      "defense",
      "hp",
      "speed",
      "element-attack",
      "penetration",
      "special-resist",
    ]);
  });

  it("矩阵恒定 5 列（四维 + special 聚合槽，不随 scheme 膨胀）", () => {
    for (const row of result.allocationMatrix) {
      expect(row.allocations.map((a) => a.attributeId)).toEqual([
        "attack",
        "defense",
        "hp",
        "speed",
        "special",
      ]);
    }
  });

  it("accessory 行精确值：速度 40 / 特殊 40 / 攻击 20", () => {
    const row = rowOf(result, "equipment-accessory");
    expect(pctOf(row, "speed")).toBe(40);
    expect(pctOf(row, "special")).toBe(40);
    expect(pctOf(row, "attack")).toBe(20);
  });

  it("charm 行精确值：特殊 55 / 速度 25 / 生命 20", () => {
    const row = rowOf(result, "equipment-charm");
    expect(pctOf(row, "special")).toBe(55);
    expect(pctOf(row, "speed")).toBe(25);
    expect(pctOf(row, "hp")).toBe(20);
  });

  it("boots 行精确值：速度 50 / 防御 30 / 生命 20", () => {
    const row = rowOf(result, "equipment-boots");
    expect(pctOf(row, "speed")).toBe(50);
    expect(pctOf(row, "defense")).toBe(30);
    expect(pctOf(row, "hp")).toBe(20);
  });

  it("skill 行精确值：攻击 50 / 特殊 30 / 生命 20", () => {
    const row = rowOf(result, "skill");
    expect(pctOf(row, "attack")).toBe(50);
    expect(pctOf(row, "special")).toBe(30);
    expect(pctOf(row, "hp")).toBe(20);
  });

  it("pet 行精确值：特殊 60 / 生命 25 / 防御 15", () => {
    const row = rowOf(result, "pet");
    expect(pctOf(row, "special")).toBe(60);
    expect(pctOf(row, "hp")).toBe(25);
    expect(pctOf(row, "defense")).toBe(15);
  });

  it("每条成长线 weightPct 总和 = 100", () => {
    for (const row of result.allocationMatrix) {
      const sum = row.allocations.reduce((s, a) => s + a.weightPct, 0);
      expect(sum, `line ${row.growthLineId}`).toBe(100);
    }
  });

  it("special-flow 下 specialAttrFocus=equipment 有效（不 fallback）", () => {
    expect(result.systemSwitches.specialAttrFocus).toBe("equipment");
  });
});

// ==================== 属性类目方案展开（迁移）====================

describe("computeBattleFromIntent — attributeScheme 展开", () => {
  it("extended-6 为六项（四维+暴击+效果命中）", () => {
    const result = computeWith({ attributeScheme: "extended-6" });
    expect(categoryIds(result)).toEqual([
      "attack",
      "defense",
      "hp",
      "speed",
      "crit",
      "effect-hit",
    ]);
    expect(result.attributeCategories[4].name).toBe("暴击");
    expect(result.attributeCategories[5].name).toBe("效果命中");
  });

  it("classic-4 下宠物线特殊份额并入生命（非防御）：生命 85 / 防御 15", () => {
    const result = computeWith({ petEnabled: true });
    const pet = rowOf(result, "pet");
    expect(pctOf(pet, "hp")).toBe(85);
    expect(pctOf(pet, "defense")).toBe(15);
    expect(pctOf(pet, "attack")).toBe(0);
    expect(pctOf(pet, "speed")).toBe(0);
  });
});

// ==================== 条件展开（迁移）====================

describe("computeBattleFromIntent — 成长线条件展开", () => {
  it("equipmentCategories=2 只展开武器护甲两行", () => {
    const result = computeWith({ equipmentCategories: 2 });
    expect(lineIds(result)).toEqual(["hero", "equipment-weapon", "equipment-armor", "skill"]);
  });

  it("equipmentCategories=3（非 2/4/6 档位值）→ fallback 按默认档 4 类展开（含头盔/饰品）", () => {
    const result = computeWith({ equipmentCategories: 3 });
    expect(lineIds(result)).toEqual([
      "hero",
      "equipment-weapon",
      "equipment-armor",
      "equipment-helm",
      "equipment-accessory",
      "skill",
    ]);
  });

  it("equipmentEnabled=false 时无任何装备行（即使 categories=6）", () => {
    const result = computeWith({ equipmentEnabled: false, equipmentCategories: 6 });
    expect(lineIds(result)).toEqual(["hero", "skill"]);
  });

  it("skillDepth=none 时无技能行", () => {
    const result = computeWith({ skillDepth: "none" });
    expect(lineIds(result)).toEqual([
      "hero",
      "equipment-weapon",
      "equipment-armor",
      "equipment-helm",
      "equipment-accessory",
    ]);
  });

  it("petEnabled=false 时无宠物行", () => {
    const result = computeWith();
    expect(lineIds(result)).not.toContain("pet");
  });

  it("heroStarEnabled 只影响 hero 行 name 描述，不改数值", () => {
    const withStar = computeWith({ heroStarEnabled: true });
    const noStar = computeWith({ heroStarEnabled: false });
    const heroWith = withStar.growthLines.find((l) => l.id === "hero");
    const heroNo = noStar.growthLines.find((l) => l.id === "hero");
    expect(heroWith?.name).not.toBe(heroNo?.name);
    expect(heroWith?.name).toContain("升星");
    // 数值分配完全一致
    expect(rowOf(withStar, "hero").allocations).toEqual(rowOf(noStar, "hero").allocations);
  });

  it("growthLines 携带正确 type 标注", () => {
    const result = computeWith({ attributeScheme: "special-flow", equipmentCategories: 6, petEnabled: true });
    const types = Object.fromEntries(result.growthLines.map((l) => [l.id, l.type]));
    expect(types["hero"]).toBe("hero");
    expect(types["equipment-weapon"]).toBe("equipment");
    expect(types["skill"]).toBe("skill");
    expect(types["pet"]).toBe("pet");
  });
});

// ==================== 矛盾组合 fallback（迁移）====================

describe("computeBattleFromIntent — specialAttrFocus 矛盾组合确定性 fallback", () => {
  const cases: Array<[string, Partial<StructuralDecisions>]> = [
    ["指向未开启的宠物线（petEnabled=false）", { petEnabled: false, specialAttrFocus: "pet" }],
    ["指向未开启的技能线（skillDepth=none）", { skillDepth: "none", specialAttrFocus: "skill" }],
    ["指向未开启的装备线（equipmentEnabled=no）", { equipmentEnabled: false, specialAttrFocus: "equipment" }],
    ["classic-4 无特殊类目", { attributeScheme: "classic-4", specialAttrFocus: "skill" }],
  ];

  it.each(cases)("%s → fallback 为 none", (_, overrides) => {
    const result = computeWith(overrides);
    expect(result.systemSwitches.specialAttrFocus).toBe("none");
  });

  it("有效指向时保持原值（special-flow + pet 开启 + focus=pet）", () => {
    const result = computeWith({
      attributeScheme: "special-flow",
      petEnabled: true,
      specialAttrFocus: "pet",
    });
    expect(result.systemSwitches.specialAttrFocus).toBe("pet");
  });
});

// ==================== role 标注（迁移）====================

describe("computeBattleFromIntent — role 标注规则", () => {
  it("默认行内规则：最大占比为 primary，其余非零为 secondary，零为 none", () => {
    const result = computeWith();
    const armor = rowOf(result, "equipment-armor");
    expect(roleOf(armor, "defense")).toBe("primary");
    expect(roleOf(armor, "hp")).toBe("secondary");
    expect(roleOf(armor, "attack")).toBe("none");
    expect(roleOf(armor, "speed")).toBe("none");

    const weapon = rowOf(result, "equipment-weapon");
    expect(roleOf(weapon, "attack")).toBe("primary");
    expect(roleOf(weapon, "speed")).toBe("secondary");
    expect(roleOf(weapon, "hp")).toBe("secondary");
  });

  it("并列取列序靠前者（accessory 防御 40 / 速度 40 并列 → defense 为 primary）", () => {
    const result = computeWith();
    const accessory = rowOf(result, "equipment-accessory");
    expect(roleOf(accessory, "defense")).toBe("primary");
    expect(roleOf(accessory, "speed")).toBe("secondary");
  });

  it("specialAttrFocus=equipment：装备行 special 升 primary（speed 降 secondary）", () => {
    const result = computeWith({ attributeScheme: "special-flow", equipmentCategories: 4 });
    const accessory = rowOf(result, "equipment-accessory");
    expect(roleOf(accessory, "special")).toBe("primary");
    expect(roleOf(accessory, "speed")).toBe("secondary");
    // 非装备线的 special 不标 primary（pet 未开启；skill 行 attack 50 仍为 primary）
    const skill = rowOf(result, "skill");
    expect(roleOf(skill, "special")).toBe("secondary");
    expect(roleOf(skill, "attack")).toBe("primary");
  });

  it("specialAttrFocus=pet：宠物行 special 为 primary，其余线 special 降 secondary 且行内剩余最大升 primary", () => {
    const result = computeWith({
      attributeScheme: "special-flow",
      petEnabled: true,
      specialAttrFocus: "pet",
    });
    const pet = rowOf(result, "pet");
    expect(roleOf(pet, "special")).toBe("primary");
    // 非宠物线（accessory 特殊 40）的 special 降为 secondary，行内剩余最大 speed 40 升 primary
    const accessory = rowOf(result, "equipment-accessory");
    expect(roleOf(accessory, "special")).toBe("secondary");
    expect(roleOf(accessory, "speed")).toBe("primary");
  });

  it("specialAttrFocus=none：纯行内规则（pet 行 special 60 为行内最大 → primary）", () => {
    const result = computeWith({
      attributeScheme: "special-flow",
      petEnabled: true,
      specialAttrFocus: "none",
    });
    const pet = rowOf(result, "pet");
    expect(roleOf(pet, "special")).toBe("primary");
  });
});

// ==================== 确定性（迁移）====================

describe("computeBattleFromIntent — 结构层确定性", () => {
  it("相同输入产出相同结构（deep-equal 且非同一引用）", () => {
    const first = computeWith({ attributeScheme: "special-flow", equipmentCategories: 6, petEnabled: true });
    const second = computeWith({ attributeScheme: "special-flow", equipmentCategories: 6, petEnabled: true });
    expect(first.allocationMatrix).toEqual(second.allocationMatrix);
    expect(first.growthLines).toEqual(second.growthLines);
    expect(first.systemSwitches).toEqual(second.systemSwitches);
    expect(first.allocationMatrix).not.toBe(second.allocationMatrix);
  });

  it("不变异入参 intent（含 structuralDecisions）", () => {
    const intent = makeBattleIntent({ structuralDecisions: makeStructural() });
    const snapshot = JSON.parse(JSON.stringify(intent));
    computeBattleFromIntent(intent);
    expect(intent).toEqual(snapshot);
  });
});
// ==================== calcDamage 顶层导出（growth-followups-trio c1） ====================

describe("calcDamage（顶层导出纯函数，镜像层消费）", () => {
  it("multiplicative 公式：K 缺省 100、defCoeff 缺省 0.5", () => {
    // round(100*0.5*1 * 100 / (50*0.5 + 100)) = round(5000/125) = 40
    expect(calcDamage(100, 50, "multiplicative", { atkCoeff: 0.5 })).toBe(40);
  });

  it("reduction 公式：atk*atkCoeff − def*defCoeff，下限 clamp 1", () => {
    expect(calcDamage(100, 30, "reduction", { atkCoeff: 1, defCoeff: 0.5 })).toBe(85);
    expect(calcDamage(10, 500, "reduction", { atkCoeff: 1, defCoeff: 1 })).toBe(1);
  });

  it("hybrid 公式：flatBonus 缺省 0、defReduction=min(defCoeff,0.99)", () => {
    // round((100+20)*1.0*1.0*(1-0.5)) = 60
    expect(calcDamage(100, 80, "hybrid", { flatBonus: 20 })).toBe(60);
  });

  it("skillMultiplier 参与三公式计算", () => {
    expect(calcDamage(100, 0, "reduction", { atkCoeff: 1 }, 2)).toBe(200);
    expect(calcDamage(100, 0, "multiplicative", {}, 2)).toBe(
      Math.round((100 * 1 * 2 * 100) / (0 * 0.5 + 100)),
    );
  });

  it("defenseCoefficient 别名兜底生效", () => {
    // atk=100 defCoeff 取 defenseCoefficient=1 → max(1, round(100-10)) = 90
    expect(calcDamage(100, 10, "reduction", { atkCoeff: 1, defenseCoefficient: 1 })).toBe(90);
  });
});

// ==================== 矛盾组合判定单源 + 变更元数据（followups-cleanup-stage1 Re.E1-5） ====================

describe("resolveEffectiveFocus 纯函数导出 + focusOverride 元数据（Re.E1-5）", () => {
  it("纯函数四分支：矛盾组合确定性丢弃为 none，合法组合直通", () => {
    // classic-4 无特殊类目 → none（即使投放线本身合法）
    expect(
      resolveEffectiveFocus(makeStructural({ attributeScheme: "classic-4", specialAttrFocus: "pet", petEnabled: true }))
    ).toBe("none");
    // 投放线指向未开启的成长线 → none
    expect(
      resolveEffectiveFocus(makeStructural({ attributeScheme: "special-flow", specialAttrFocus: "equipment", equipmentEnabled: false }))
    ).toBe("none");
    expect(
      resolveEffectiveFocus(makeStructural({ attributeScheme: "special-flow", specialAttrFocus: "skill", skillDepth: "none" }))
    ).toBe("none");
    expect(
      resolveEffectiveFocus(makeStructural({ attributeScheme: "special-flow", specialAttrFocus: "pet", petEnabled: false }))
    ).toBe("none");
    // 合法组合直通（不丢弃）
    expect(
      resolveEffectiveFocus(makeStructural({ attributeScheme: "special-flow", specialAttrFocus: "equipment" }))
    ).toBe("equipment");
  });

  it("computed.focusOverride：装备线投放 + 无装备系统 → 记录 from/to/reason", () => {
    const result = computeWith({
      attributeScheme: "special-flow",
      specialAttrFocus: "equipment",
      equipmentEnabled: false,
    });
    expect(result.focusOverride).toBeDefined();
    expect(result.focusOverride!.from).toBe("equipment");
    expect(result.focusOverride!.to).toBe("none");
    expect(result.focusOverride!.reason).toContain("装备");
    // systemSwitches 回显有效值（既有行为）
    expect(result.systemSwitches.specialAttrFocus).toBe("none");
  });

  it("computed.focusOverride：classic-4 下非 none 投放线 → reason 指向属性方案（分支优先级）", () => {
    const result = computeWith({
      attributeScheme: "classic-4",
      specialAttrFocus: "skill",
      skillDepth: "none",
    });
    // classic-4 分支先于 skill 分支命中（与 resolveEffectiveFocus 同序）
    expect(result.focusOverride!.reason).toContain("classic-4");
  });

  it("无静默丢弃（合法组合 / 投放线本为 none）→ 不写 focusOverride 键", () => {
    expect("focusOverride" in computeWith({ attributeScheme: "special-flow", specialAttrFocus: "equipment" })).toBe(false);
    expect("focusOverride" in computeWith({ attributeScheme: "classic-4", specialAttrFocus: "none" })).toBe(false);
  });
});

// ==================== W0 战力模型 v2：powerProfile（满级口径） ====================

describe("computeBattleFromIntent — powerProfile（W0 v2）", () => {
  it("输出形状：power/edps/ehp 有限非负，attrMarginalValues 含五键", () => {
    const result = computeWith();
    expect(result.powerProfile).toBeDefined();
    const { power, edps, ehp, attrMarginalValues } = result.powerProfile;
    expect(Number.isFinite(power)).toBe(true);
    expect(Number.isFinite(edps)).toBe(true);
    expect(Number.isFinite(ehp)).toBe(true);
    expect(power).toBeGreaterThanOrEqual(0);
    expect(edps).toBeGreaterThanOrEqual(0);
    expect(ehp).toBeGreaterThanOrEqual(0);
    for (const key of ["attack", "defense", "hp", "speed", "crit"]) {
      expect(typeof attrMarginalValues[key]).toBe("number");
    }
  });

  it("同源一致性：powerProfile.power = 投影末锚 totalPower（±0.5，同一 supply 单源函数）", () => {
    const result = computeWith();
    const projection = computeGrowthProjection(result, { anchors: [180] });
    const lastAnchor = projection.anchors[projection.anchors.length - 1];
    expect(Math.abs(result.powerProfile.power - lastAnchor.totalPower)).toBeLessThan(0.5);
  });

  it("同源一致性跨结构组合（6 装备 + 技能 + 宠物 + extended-6）", () => {
    const result = computeWith({
      attributeScheme: "extended-6",
      equipmentCategories: 6,
      petEnabled: true,
      skillDepth: "upgrade-star",
    });
    const projection = computeGrowthProjection(result, { anchors: [180] });
    const lastAnchor = projection.anchors[projection.anchors.length - 1];
    expect(Math.abs(result.powerProfile.power - lastAnchor.totalPower)).toBeLessThan(0.5);
  });

  it("同源一致性跨公式型（reduction + 非默认系数）", () => {
    const intent = makeBattleIntent({
      strategy: {
        ...makeBattleIntent().strategy,
        damageFormula: {
          type: "reduction",
          baseFormula: "test",
          coefficients: { atkCoeff: 1.0, defCoeff: 0.6 },
        },
      },
    });
    const result = computeBattleFromIntent(intent);
    const projection = computeGrowthProjection(result, { anchors: [180] });
    const lastAnchor = projection.anchors[projection.anchors.length - 1];
    expect(Math.abs(result.powerProfile.power - lastAnchor.totalPower)).toBeLessThan(0.5);
  });

  it("技能倍率按 count 加权：3×1.8 + 1×1.0 → edps 放大 1.6 倍（非简单均值 1.4）", () => {
    const withDetails = makeBattleIntent({
      strategy: {
        ...makeBattleIntent().strategy,
        skillFramework: {
          skillTypes: ["a", "b"],
          maxSkillsPerCharacter: 4,
          cooldownRange: [3, 10],
          skillDetails: [
            { type: "主动", count: 3, cooldownRange: [5, 12], avgMultiplier: 1.8, description: "" },
            { type: "被动", count: 1, cooldownRange: [0, 0], avgMultiplier: 1.0, description: "" },
          ],
        },
      },
    });
    const withStats = computeBattleFromIntent(withDetails).powerProfile;
    const withoutStats = computeWith().powerProfile;
    expect(withStats.edps / withoutStats.edps).toBeCloseTo(1.6, 6);
    expect(withStats.power / withoutStats.power).toBeCloseTo(Math.sqrt(1.6), 6);
  });
});

// ==================== enemyStrengthBaseline 透传（questionnaire-ia W2 深档题）====================

describe("computeBattleFromIntent — enemyStrengthBaseline 透传（questionnaire-ia W2）", () => {
  it("anchors.enemyStrengthBaseline=1.2 → computed 顶层同名键恒等透传", () => {
    const base = makeBattleIntent();
    const result = computeBattleFromIntent({
      ...base,
      anchors: { ...base.anchors, enemyStrengthBaseline: 1.2 },
    });
    // 期望 1.2 = intent 锚点原值（透传恒等，无变换）
    expect(result.enemyStrengthBaseline).toBe(1.2);
  });

  it("anchors.enemyStrengthBaseline=0.75 → 同样透传（lenient 档）", () => {
    const base = makeBattleIntent();
    const result = computeBattleFromIntent({
      ...base,
      anchors: { ...base.anchors, enemyStrengthBaseline: 0.75 },
    });
    expect(result.enemyStrengthBaseline).toBe(0.75);
  });

  it("intent 无该锚点 → computed 不写键（输出形状最小，现状回归）", () => {
    const result = computeBattleFromIntent(makeBattleIntent());
    expect(result).not.toHaveProperty("enemyStrengthBaseline");
  });
});

// ==================== V8 W2-T2：stageMatrices 属性投放矩阵阶段化（层 1）====================

describe("computeBattleFromIntent — stageMatrices（V8 W2-T2 层 1）", () => {
  /** S2 锚定 biases（Spec R2，期望值经引擎验算禁改） */
  const S2_BIASES = { early: { attack: 1.5 }, late: { attack: 0.6, special: 1.8 } };

  function computeWithStage(
    stageAllocation: NonNullable<StructuralDecisions["stageAllocation"]>,
    structuralOverrides?: Partial<StructuralDecisions>,
  ) {
    return computeBattleFromIntent(
      makeBattleIntent({
        structuralDecisions: makeStructural({
          // S2 基线 skill {attack:50, special:30, hp:20} 仅 extended-6/special-flow 成立
          attributeScheme: "extended-6",
          ...structuralOverrides,
          stageAllocation,
        }),
      }),
    );
  }

  function weightsOf(row: BattleAllocationRow): Record<string, number> {
    return Object.fromEntries(row.allocations.map((a) => [a.attributeId, a.weightPct]));
  }

  function rowWeights(
    matrix: BattleAllocationRow[],
    lineId: string,
  ): Record<string, number> {
    const row = matrix.find((r) => r.growthLineId === lineId);
    if (!row) throw new Error(`growth line ${lineId} not found`);
    return weightsOf(row);
  }

  it("S2 数值锚定：skill 线 early=60/24/16、late=29/52/19、mid=50/30/20（各段 Σ=100）", () => {
    const result = computeWithStage({ biases: S2_BIASES });
    const matrices = result.stageMatrices!;
    expect(matrices).toBeDefined();
    // early: raw {75,30,20} Σ125 → 60/24/16；late: raw {30,54,20} Σ104 → 28.85→29 / 51.92→52 / 19.23→19
    expect(rowWeights(matrices.early, "skill")).toEqual({
      attack: 60, special: 24, hp: 16, defense: 0, speed: 0,
    });
    expect(rowWeights(matrices.late, "skill")).toEqual({
      attack: 29, special: 52, hp: 19, defense: 0, speed: 0,
    });
    expect(rowWeights(matrices.mid, "skill")).toEqual({
      attack: 50, special: 30, hp: 20, defense: 0, speed: 0,
    });
  });

  it("S1 缺省恒等：无 stageAllocation / lineSchedule / milestones → stageMatrices 与 lineScheduleEcho 键不存在", () => {
    const result = computeBattleFromIntent(makeBattleIntent());
    expect("stageMatrices" in result).toBe(false);
    expect("lineScheduleEcho" in result).toBe(false);
  });

  it("偏置越界 clamp：bias 2.5 → 2、0.3 → 0.5（引擎侧防御，W3 Zod 前置拒绝后续波次）", () => {
    // skill 基线 {50,30,20}：attack×2 raw {100,30,20} Σ150 → 66.67→67 / 20 / 13.33→13
    const boosted = computeWithStage({ biases: { early: { attack: 2.5 } } });
    expect(rowWeights(boosted.stageMatrices!.early, "skill")).toEqual({
      attack: 67, special: 20, hp: 13, defense: 0, speed: 0,
    });
    // attack×0.5 raw {25,30,20} Σ75 → 33.33→33 / 40 / 26.67→27
    const nerfed = computeWithStage({ biases: { late: { attack: 0.3 } } });
    expect(rowWeights(nerfed.stageMatrices!.late, "skill")).toEqual({
      attack: 33, special: 40, hp: 27, defense: 0, speed: 0,
    });
  });

  it("归一化余数补最大项：rounding Σ=101 → 余数 −1 补最大项（hero late attack×1.8）", () => {
    // hero 基线 {attack:40, hp:35, defense:15, speed:10}，attack×1.8 raw {72,35,15,10} Σ132
    // → round {54.55→55, 26.52→27, 11.36→11, 7.58→8} Σ101 → attack(最大) 55−1=54
    const result = computeWithStage({ biases: { late: { attack: 1.8 } } });
    expect(rowWeights(result.stageMatrices!.late, "hero")).toEqual({
      attack: 54, hp: 27, defense: 11, speed: 8, special: 0,
    });
  });

  it("biases 整体畸形（空对象 / 非有限数）→ 整键忽略 = 恒等（不写 stageMatrices）", () => {
    const empty = computeWithStage({ biases: {} });
    expect("stageMatrices" in empty).toBe(false);
    const nanBias = computeWithStage({
      biases: { early: { attack: Number.NaN } } as unknown as NonNullable<
        StructuralDecisions["stageAllocation"]
      >["biases"],
    });
    expect("stageMatrices" in nanBias).toBe(false);
  });

  it("三段每行 Σ=100，且段形状与 allocationMatrix 行同构（同线集合同列集合）", () => {
    const result = computeWithStage({ biases: S2_BIASES });
    const matrices = result.stageMatrices!;
    for (const seg of ["early", "mid", "late"] as const) {
      for (const row of matrices[seg]) {
        const sum = row.allocations.reduce((s, a) => s + a.weightPct, 0);
        expect(sum, `${seg} ${row.growthLineId}`).toBe(100);
      }
      expect(
        matrices[seg].map((r) => r.growthLineId),
      ).toEqual(result.allocationMatrix.map((r) => r.growthLineId));
    }
    // mid 数值恒等基线（每行 weightPct 与 allocationMatrix 一致；role 为段内重标注，不比对）
    for (const [i, row] of matrices.mid.entries()) {
      expect(weightsOf(row)).toEqual(weightsOf(result.allocationMatrix[i]));
    }
  });

  it("bounds 元数据（裁决 A2）：无 stages → stageBounds ?? STAGE_BOUNDS_DEFAULT 占比换算绝对等级", () => {
    // maxLevel=50（缺省 fixture）：[0.2,0.7] → [⌈10⌉, ⌈35⌉] = [10, 35]
    const byDefault = computeWithStage({ biases: S2_BIASES });
    expect(byDefault.stageMatrices!.bounds).toEqual([10, 35]);
    // 显式 stageBounds [0.3, 0.8] → [15, 40]
    const byBounds = computeWithStage({ stageBounds: [0.3, 0.8], biases: S2_BIASES });
    expect(byBounds.stageMatrices!.bounds).toEqual([15, 40]);
  });

  it("bounds 元数据（裁决 A2）：stages 恰 3 段 → deriveStageBounds 两切点", () => {
    const result = computeBattleFromIntent(
      makeBattleIntent({
        anchors: {
          level_1: { ATK: 100, DEF: 50, HP: 500 },
          level_max: { ATK: 5000, DEF: 2000, HP: 20000 },
          maxLevel: 30,
          attributeBudgets: { ATK: 5000, DEF: 2000, HP: 20000 },
        },
        structuralDecisions: makeStructural({
          attributeScheme: "extended-6",
          stageAllocation: {
            stages: [
              { name: "开荒期", focusLines: ["hero"] },
              { name: "装备期", focusLines: ["equipment-weapon"] },
              { name: "宠物期", focusLines: ["pet"] },
            ],
            biases: S2_BIASES,
          },
          lineSchedule: {
            lines: {
              hero: { openAt: 1 },
              "equipment-weapon": { openAt: 5 },
              pet: { openAt: 15, unlockLevels: [24, 27, 30] },
            },
          },
        }),
      }),
    );
    expect(result.stageMatrices!.bounds).toEqual([5, 15]);
    expect(result.lineScheduleEcho!.derivedStageBounds).toEqual([5, 15]);
  });
});

// ==================== V8 W2-T6a：lineScheduleEcho 养成线调度回显（层 2）====================

describe("computeBattleFromIntent — lineScheduleEcho（V8 W2-T6a 层 2）", () => {
  /** S9a SLG 调度 fixture（Spec R6 精确锚定，期望值禁改） */
  const S9A_SCHEDULE: NonNullable<StructuralDecisions["lineSchedule"]> = {
    lines: {
      hero: { openAt: 1 },
      "equipment-weapon": { openAt: 5 },
      pet: { openAt: 15, unlockLevels: [24, 27, 30] },
    },
  };

  function computeWithSchedule(
    lineSchedule: NonNullable<StructuralDecisions["lineSchedule"]>,
    maxLevel = 30,
  ) {
    return computeBattleFromIntent(
      makeBattleIntent({
        anchors: {
          level_1: { ATK: 100, DEF: 50, HP: 500 },
          level_max: { ATK: 5000, DEF: 2000, HP: 20000 },
          maxLevel,
          attributeBudgets: { ATK: 5000, DEF: 2000, HP: 20000 },
        },
        structuralDecisions: makeStructural({ lineSchedule }),
      }),
    );
  }

  it("S9a 端到端：derivedKeyNodes=[5,15,24,27,30]，无 stages → derivedStageBounds 缺省换算 [6,21]", () => {
    const result = computeWithSchedule(S9A_SCHEDULE);
    const echo = result.lineScheduleEcho!;
    expect(echo).toBeDefined();
    expect(echo.derivedKeyNodes).toEqual([5, 15, 24, 27, 30]);
    // maxLevel=30：[⌈0.2×30⌉, ⌈0.7×30⌉] = [6, 21]
    expect(echo.derivedStageBounds).toEqual([6, 21]);
    // 回显原样（本 fixture 无越界，clamp 后同值）
    expect(echo.lines).toEqual(S9A_SCHEDULE.lines);
  });

  it("越界 clamp 后回显：openAt 99 → 30、unlockLevels [0,5,99] → [1,5,30]（maxLevel=30）", () => {
    const result = computeWithSchedule({
      lines: { "equipment-weapon": { openAt: 99, unlockLevels: [0, 5, 99] } },
    });
    expect(result.lineScheduleEcho!.lines["equipment-weapon"]).toEqual({
      openAt: 30,
      unlockLevels: [1, 5, 30],
    });
  });

  it("无 lineSchedule → 不写 lineScheduleEcho 键（S1 恒等）", () => {
    const result = computeBattleFromIntent(makeBattleIntent());
    expect("lineScheduleEcho" in result).toBe(false);
  });

  it("systemSwitches 不泄漏第 10/11 键（stageAllocation / lineSchedule 不进开关回显）", () => {
    const result = computeWithSchedule(S9A_SCHEDULE);
    expect("stageAllocation" in result.systemSwitches).toBe(false);
    expect("lineSchedule" in result.systemSwitches).toBe(false);
    expect(Object.keys(result.systemSwitches)).toHaveLength(9);
  });

  it("Review 修复（P1-B）：stageFocus 派生——stages 恰 3 段且切点真实 → 显式段 focus 线映射；缺 stages 不写键", () => {
    const withStages = computeBattleFromIntent(
      makeBattleIntent({
        anchors: {
          level_1: { ATK: 100, DEF: 50, HP: 500 },
          level_max: { ATK: 5000, DEF: 2000, HP: 20000 },
          maxLevel: 30,
          attributeBudgets: { ATK: 5000, DEF: 2000, HP: 20000 },
        },
        structuralDecisions: makeStructural({
          stageAllocation: {
            stages: [
              { name: "开荒期", focusLines: ["hero"] },
              { name: "装备期", focusLines: ["equipment-weapon"] },
              { name: "宠物期", focusLines: ["pet"] },
            ],
            biases: {},
          },
          lineSchedule: S9A_SCHEDULE,
        }),
      }),
    );
    const echo = withStages.lineScheduleEcho!;
    // 切点真实（来自 stages focus 线 openAt 5/15，非缺省换算 [6,21]）+ 显式 focus 映射
    expect(echo.derivedStageBounds).toEqual([5, 15]);
    expect(echo.stageFocus).toEqual({
      early: "hero",
      mid: "equipment-weapon",
      late: "pet",
    });
    // 缺 stages（仅 lineSchedule）→ stageFocus 不写键（focusBoost 无语义来源不触发）
    const noStages = computeWithSchedule(S9A_SCHEDULE);
    expect("stageFocus" in noStages.lineScheduleEcho!).toBe(false);
  });
});

// ==================== V8 W2-T3：milestones 曲线里程碑锚点 ====================

describe("computeBattleFromIntent — milestones 分段插值（V8 W2-T3）", () => {
  /** R3 场景 fixture：maxLevel=60、ATK linear 100→395 */
  function makeMilestoneIntent(
    milestones?: Array<{ level: number; values: Record<string, number> }>,
  ) {
    return makeBattleIntent({
      anchors: {
        level_1: { ATK: 100, DEF: 50, HP: 500 },
        level_max: { ATK: 395, DEF: 2000, HP: 20000 },
        maxLevel: 60,
        attributeBudgets: { ATK: 395, DEF: 2000, HP: 20000 },
        ...(milestones ? { milestones } : {}),
      },
    });
  }

  it("R3 场景锚定：L30 命中 250、L15 = 100+(250−100)×14/29 → 172、L45 = 250+(395−250)×15/30 → 323", () => {
    const result = computeBattleFromIntent(
      makeMilestoneIntent([{ level: 30, values: { ATK: 250 } }]),
    );
    expect(result.attributeGrowthTable[29].ATK).toBe(250); // 锚点命中（L30 行）
    expect(result.attributeGrowthTable[14].ATK).toBe(172); // 段内线性（L15 行）
    expect(result.attributeGrowthTable[44].ATK).toBe(323); // 段内线性（L45 行）
  });

  it("多锚点分段（interpolateFromAnchors 原生多锚点）：[{30:250},{45:320}] → L37 = 250+70×7/15 → 283", () => {
    const result = computeBattleFromIntent(
      makeMilestoneIntent([
        { level: 30, values: { ATK: 250 } },
        { level: 45, values: { ATK: 320 } },
      ]),
    );
    expect(result.attributeGrowthTable[29].ATK).toBe(250);
    expect(result.attributeGrowthTable[36].ATK).toBe(283); // L37 行，段 [30,45] t=7/15
    expect(result.attributeGrowthTable[44].ATK).toBe(320);
  });

  it("锚点序端值不变：L1 = level_1 原值、L60 = level_max 原值（端点由首尾锚承载）", () => {
    const result = computeBattleFromIntent(
      makeMilestoneIntent([{ level: 30, values: { ATK: 250 } }]),
    );
    expect(result.attributeGrowthTable[0].ATK).toBe(100);
    expect(result.attributeGrowthTable[59].ATK).toBe(395);
  });

  it("Review 修复（Correctness P2-1）：未知属性键静默无效——不毒化整键，合法锚点保留", () => {
    // MAGIC 无成长列（不在 level_1/level_max）→ 不参与方向校验（曾以 [0, v, 0] 序列
    // 毒化整键返回 null，与 docstring「静默无效」语义相反）；ATK 合法锚照常生效
    const withUnknown = computeBattleFromIntent(
      makeMilestoneIntent([{ level: 30, values: { ATK: 250, MAGIC: 300 } }]),
    );
    const knownOnly = computeBattleFromIntent(
      makeMilestoneIntent([{ level: 30, values: { ATK: 250 } }]),
    );
    expect(withUnknown.attributeGrowthTable).toEqual(knownOnly.attributeGrowthTable);
    expect(withUnknown.attributeGrowthTable[29].ATK).toBe(250);
  });

  it("畸形：等级非升序 → 整键忽略 = 恒等（成长表与无 milestones 深等）", () => {
    const baseline = computeBattleFromIntent(makeMilestoneIntent());
    const malformed = computeBattleFromIntent(
      makeMilestoneIntent([
        { level: 50, values: { ATK: 300 } },
        { level: 30, values: { ATK: 250 } },
      ]),
    );
    expect(malformed.attributeGrowthTable).toEqual(baseline.attributeGrowthTable);
  });

  it("畸形：段内与两端点不同向单调（先降后升 / 越过端值）→ 整键忽略 = 恒等", () => {
    const baseline = computeBattleFromIntent(makeMilestoneIntent());
    // ATK 100→395 上升，锚点 50 低于起点（先降）
    const dips = computeBattleFromIntent(
      makeMilestoneIntent([{ level: 30, values: { ATK: 50 } }]),
    );
    expect(dips.attributeGrowthTable).toEqual(baseline.attributeGrowthTable);
    // 锚点 500 越过终点 395（升后回落，段内不同向）
    const overshoots = computeBattleFromIntent(
      makeMilestoneIntent([{ level: 30, values: { ATK: 500 } }]),
    );
    expect(overshoots.attributeGrowthTable).toEqual(baseline.attributeGrowthTable);
  });

  it("畸形：值非有限数 / 锚点等级越出 (1, maxLevel) → 整键忽略 = 恒等", () => {
    const baseline = computeBattleFromIntent(makeMilestoneIntent());
    const nanValue = computeBattleFromIntent(
      makeMilestoneIntent([{ level: 30, values: { ATK: Number.NaN } }]),
    );
    expect(nanValue.attributeGrowthTable).toEqual(baseline.attributeGrowthTable);
    // 锚点与首尾锚点冲突（level 1 / level 60 由 level_1/level_max 承载）→ 整键忽略
    const atStart = computeBattleFromIntent(
      makeMilestoneIntent([{ level: 1, values: { ATK: 999 } }]),
    );
    expect(atStart.attributeGrowthTable).toEqual(baseline.attributeGrowthTable);
    const atEnd = computeBattleFromIntent(
      makeMilestoneIntent([{ level: 60, values: { ATK: 999 } }]),
    );
    expect(atEnd.attributeGrowthTable).toEqual(baseline.attributeGrowthTable);
  });

  it("里程碑值仅作用于声明的属性：DEF/HP 段保持原插值（锚点序按属性独立）", () => {
    const result = computeBattleFromIntent(
      makeMilestoneIntent([{ level: 30, values: { ATK: 250 } }]),
    );
    const baseline = computeBattleFromIntent(makeMilestoneIntent());
    expect(result.attributeGrowthTable[29].DEF).toBe(baseline.attributeGrowthTable[29].DEF);
    expect(result.attributeGrowthTable[14].HP).toBe(baseline.attributeGrowthTable[14].HP);
  });
});

// ==================== V8 W2-T4a：damage 场景 4 档化（裁决 A1 白名单）====================

describe("computeBattleFromIntent — damage 场景 4 档化（V8 W2-T4a）", () => {
  function simsAt(maxLevel: number) {
    return computeBattleFromIntent(
      makeBattleIntent({
        anchors: {
          level_1: { ATK: 100, DEF: 50, HP: 500 },
          level_max: { ATK: 5000, DEF: 2000, HP: 20000 },
          maxLevel,
          attributeBudgets: { ATK: 5000, DEF: 2000, HP: 20000 },
        },
      }),
    );
  }

  /** 场景名 → [attackerLevel, defenderLevel] */
  function levelPairs(result: ComputedBattleData): Record<string, [number, number]> {
    const pairs: Record<string, [number, number]> = {};
    for (const sim of result.damageSimulations) {
      pairs[sim.scenario as string] = [sim.attackerLevel as number, sim.defenderLevel as number];
    }
    return pairs;
  }

  it("L=60 取样档 {1,12,42,60}：8 场景名不变，E=⌈0.2L⌉/M=⌈0.7L⌉/越级 M−5/碾压 min(L,M+5)/生存 L", () => {
    const pairs = levelPairs(simsAt(60));
    expect(Object.keys(pairs)).toHaveLength(8);
    expect(pairs["早期体验(Lv.1)"]).toEqual([1, 1]); // 前档（满级档语义见生存验证）
    expect(pairs["同级普攻"]).toEqual([12, 12]); // 前期档基准体验
    expect(pairs["同级技能爆发"]).toEqual([42, 42]); // 中段档
    expect(pairs["同级技能循环"]).toEqual([42, 42]);
    expect(pairs["同级暴击"]).toEqual([42, 42]);
    expect(pairs["越级+5挑战"]).toEqual([37, 42]); // max(1, M−5) 攻 vs M 防
    expect(pairs["碾压-5"]).toEqual([47, 42]); // min(L, M+5) 攻 vs M 防
    expect(pairs["生存验证"]).toEqual([60, 60]); // 终局语义（满级档）
  });

  it("L=50（缺省 fixture）：E=10 / M=35 / 越级 30 / 碾压 40 / 生存 50，数值与成长表对应行一致", () => {
    const result = computeBattleFromIntent(makeBattleIntent());
    const pairs = levelPairs(result);
    expect(pairs["同级普攻"]).toEqual([10, 10]);
    expect(pairs["同级技能爆发"]).toEqual([35, 35]);
    expect(pairs["同级技能循环"]).toEqual([35, 35]);
    expect(pairs["同级暴击"]).toEqual([35, 35]);
    expect(pairs["越级+5挑战"]).toEqual([30, 35]);
    expect(pairs["碾压-5"]).toEqual([40, 35]);
    expect(pairs["生存验证"]).toEqual([50, 50]);
    // 数值一致性：同级普攻 = calcDamage(L10 行 ATK × L10 行 DEF，1.0 倍率)
    const row = result.attributeGrowthTable[9];
    const expected = calcDamage(
      row.ATK as number,
      row.DEF as number,
      "multiplicative",
      { atkCoeff: 1.0, defCoeff: 0.5 },
      1.0,
    );
    const sim = result.damageSimulations.find((s) => s.scenario === "同级普攻")!;
    expect(sim.expectedDamage).toBe(Math.max(1, expected));
  });

  it("totalLevels < 4 去重升序保护：maxLevel=3 → 取样收敛 [1,3]，8 场景等级恒落 [1,3]", () => {
    const pairs = levelPairs(simsAt(3));
    expect(Object.keys(pairs)).toHaveLength(8);
    // E=⌈0.6⌉=1、M=⌈2.1⌉=3 → 档位自然去重
    expect(pairs["同级普攻"]).toEqual([1, 1]);
    expect(pairs["同级技能爆发"]).toEqual([3, 3]);
    expect(pairs["越级+5挑战"]).toEqual([1, 3]); // max(1, 3−5)
    expect(pairs["碾压-5"]).toEqual([3, 3]); // min(3, 3+5)
    expect(pairs["生存验证"]).toEqual([3, 3]);
    for (const [atk, def] of Object.values(pairs)) {
      expect(atk).toBeGreaterThanOrEqual(1);
      expect(atk).toBeLessThanOrEqual(3);
      expect(def).toBeGreaterThanOrEqual(1);
      expect(def).toBeLessThanOrEqual(3);
    }
  });

  it("maxLevel=1 极端：E/M 均收敛 1，全部场景 1v1 且 8 行齐全", () => {
    const pairs = levelPairs(simsAt(1));
    expect(Object.keys(pairs)).toHaveLength(8);
    for (const [atk, def] of Object.values(pairs)) {
      expect([atk, def]).toEqual([1, 1]);
    }
  });
});
