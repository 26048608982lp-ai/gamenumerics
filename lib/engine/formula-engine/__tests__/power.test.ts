import { describe, it, expect } from "vitest";
import {
  computePowerStats,
  normalizeAttrKey,
  weightedSkillMultiplier,
} from "../power";
import { calcDamage } from "../battle";
import type { PowerFormulaParams } from "../power";

/**
 * W0 战力模型 v2：解析 EHP×EDPS 战力单源单测。
 *
 * 可信度分级（Spec Scenario）：multiplicative/hybrid 严格（同型互打恒等）、
 * reduction 近似（方向正确率 ≥80%）。
 */

/** 标准参数 fixture（引擎兜底链同值：atkCoeff 1.0 / defCoeff 0.5 / K 100） */
function makeParams(overrides?: Partial<PowerFormulaParams>): PowerFormulaParams {
  return {
    formulaType: "multiplicative",
    coefficients: { atkCoeff: 1.0, defCoeff: 0.5, K: 100 },
    skillMultiplier: 1.0,
    stdAtk: 5000,
    stdSpeed: 50,
    ...overrides,
  };
}

// ==================== 三型公式（各 ≥1 例，手算精确值） ====================

describe("computePowerStats — 三型公式", () => {
  it("multiplicative：EDPS/EHP/Power 手算精确（sf=0.5、mitigation=1.25）", () => {
    const stats = computePowerStats(
      { attack: 100, defense: 50, hp: 1000, speed: 50 },
      makeParams()
    );
    // EDPS = 100×1×1×1×(50/100) = 50
    expect(stats.edps).toBeCloseTo(50, 10);
    // EHP = 1000 × (1 + 50×0.5/100) = 1250
    expect(stats.ehp).toBeCloseTo(1250, 10);
    // Power = √(50×1250) = 250
    expect(stats.power).toBeCloseTo(250, 10);
  });

  it("reduction：除法形态 mitigation = 1/max(0.1, 1−def×defCoeff/stdAtk)", () => {
    const stats = computePowerStats(
      { attack: 100, defense: 50, hp: 1000 },
      makeParams({ formulaType: "reduction" })
    );
    // mitigation = 1/(1 − 50×0.5/5000) = 1/0.995；EHP = 1000/0.995 ≈ 1005.025
    expect(stats.ehp).toBeCloseTo(1000 / 0.995, 6);
    expect(stats.edps).toBeCloseTo(100, 10); // speed 缺失 → sf=1
    expect(stats.power).toBeCloseTo(Math.sqrt(100 * (1000 / 0.995)), 6);
  });

  it("reduction：减伤比例触底 clamp 0.1 → mitigation ≤ 10", () => {
    const stats = computePowerStats(
      { attack: 100, defense: 49000, hp: 1000 },
      makeParams({ formulaType: "reduction" })
    );
    // 1 − 49000×0.5/5000 = −3.9 → clamp 0.1 → mitigation = 10
    expect(stats.ehp).toBeCloseTo(10000, 6);
  });

  it("hybrid：固定减免 → EHP 线性于 hp（defense 数值不参与）", () => {
    const params = makeParams({
      formulaType: "hybrid",
      coefficients: { atkCoeff: 1.0, defCoeff: 0.5 },
    });
    const low = computePowerStats({ attack: 100, defense: 10, hp: 1000 }, params);
    const high = computePowerStats({ attack: 100, defense: 9999, hp: 1000 }, params);
    // mitigation = 1/(1−0.5) = 2 → EHP = 2000 恒定
    expect(low.ehp).toBeCloseTo(2000, 10);
    expect(high.ehp).toBeCloseTo(2000, 10);
    expect(low.power).toBeCloseTo(high.power, 10);
  });

  it("critExpect：crit 百分数语义 × critDmgMult 缺省 1.5", () => {
    const stats = computePowerStats(
      { attack: 100, crit: 25 },
      makeParams({ stdSpeed: 0 })
    );
    // critExpect = 1 + 0.25×0.5 = 1.125；speed 缺失 → sf=1
    expect(stats.edps).toBeCloseTo(112.5, 10);
  });

  it("crit/speed 非数值或 ≤0 → 视为缺失走缺省分支（critExpect=1 / speedFactor=1）", () => {
    for (const crit of [0, -5, Number.NaN]) {
      const stats = computePowerStats({ attack: 100, crit }, makeParams({ stdSpeed: 0 }));
      expect(stats.edps).toBeCloseTo(100, 10);
    }
    for (const speed of [0, -10, Number.NaN]) {
      const stats = computePowerStats({ attack: 100, speed }, makeParams());
      expect(stats.edps).toBeCloseTo(100, 10);
    }
  });

  it("speedFactor：speed/(speed+stdSpeed)，参与 EDPS 计价", () => {
    const stats = computePowerStats(
      { attack: 100, speed: 150 },
      makeParams({ stdSpeed: 50 })
    );
    expect(stats.edps).toBeCloseTo(100 * (150 / 200), 10);
  });

  it("全零属性 → Power=0 不产 NaN", () => {
    for (const type of ["multiplicative", "reduction", "hybrid"] as const) {
      const stats = computePowerStats({}, makeParams({ formulaType: type }));
      expect(stats.power).toBe(0);
      expect(stats.edps).toBe(0);
      expect(stats.ehp).toBe(0);
      expect(Number.isNaN(stats.power)).toBe(false);
    }
  });

  it("系数兜底链：atkCoeff→attackCoefficient→1.0 / defCoeff→defenseCoefficient→0.5 / K→100", () => {
    const stats = computePowerStats(
      { attack: 100, defense: 50, hp: 1000, speed: 50 },
      makeParams({ coefficients: {} })
    );
    expect(stats.edps).toBeCloseTo(50, 10);
    expect(stats.ehp).toBeCloseTo(1250, 10); // K=100 / defCoeff=0.5 兜底
  });
});

// ==================== 属性边际价值（+1 数值微分） ====================

describe("computePowerStats — 属性边际价值", () => {
  it("attack/hp/defense/crit/speed 边际价值 > 0（标准均衡属性）", () => {
    const stats = computePowerStats(
      { attack: 500, defense: 500, hp: 5000, speed: 25, crit: 15 },
      makeParams()
    );
    expect(stats.attrMarginalValues.attack).toBeGreaterThan(0);
    expect(stats.attrMarginalValues.hp).toBeGreaterThan(0);
    expect(stats.attrMarginalValues.defense).toBeGreaterThan(0);
    expect(stats.attrMarginalValues.crit).toBeGreaterThan(0);
    expect(stats.attrMarginalValues.speed).toBeGreaterThan(0);
  });

  it("边际价值 = Power(attrs+1) − Power(attrs)（数值微分精确性）", () => {
    const attrs = { attack: 500, defense: 500, hp: 5000, speed: 25, crit: 15 };
    const base = computePowerStats(attrs, makeParams());
    const bumped = computePowerStats({ ...attrs, attack: attrs.attack + 1 }, makeParams());
    expect(base.attrMarginalValues.attack).toBeCloseTo(bumped.power - base.power, 12);
  });

  it("越稀缺越贵：同级尺度下投放少的属性单价更高（量级反向）", () => {
    const params = makeParams();
    // 攻击稀缺（100）vs 防御稀缺（100）：两种配置互为镜像
    const attackScarce = computePowerStats(
      { attack: 100, defense: 1000, hp: 10000 },
      params
    );
    const defenseScarce = computePowerStats(
      { attack: 1000, defense: 100, hp: 10000 },
      params
    );
    expect(attackScarce.attrMarginalValues.attack).toBeGreaterThan(
      defenseScarce.attrMarginalValues.attack
    );
    expect(defenseScarce.attrMarginalValues.defense).toBeGreaterThan(
      attackScarce.attrMarginalValues.defense
    );
  });

  it("大写键 attrs 经归一读取（禁裸读）：ATK/DEF/HP/SPD 与小写等价", () => {
    const upper = computePowerStats(
      { ATK: 100, DEF: 50, HP: 1000, SPD: 50 },
      makeParams()
    );
    const lower = computePowerStats(
      { attack: 100, defense: 50, hp: 1000, speed: 50 },
      makeParams()
    );
    expect(upper.power).toBeCloseTo(lower.power, 12);
    expect(upper.edps).toBeCloseTo(lower.edps, 12);
    expect(upper.ehp).toBeCloseTo(lower.ehp, 12);
  });
});

// ==================== normalizeAttrKey / weightedSkillMultiplier ====================

describe("normalizeAttrKey", () => {
  it("四键大写映射 + 其余小写原样", () => {
    expect(normalizeAttrKey("ATK")).toBe("attack");
    expect(normalizeAttrKey("DEF")).toBe("defense");
    expect(normalizeAttrKey("HP")).toBe("hp");
    expect(normalizeAttrKey("SPD")).toBe("speed");
    expect(normalizeAttrKey("crit")).toBe("crit");
    expect(normalizeAttrKey("effect-hit")).toBe("effect-hit");
    expect(normalizeAttrKey("atk")).toBe("atk"); // 非 spec 大写键原样小写
  });
});

describe("weightedSkillMultiplier（与 battle.ts:453 简单均值口径区分）", () => {
  it("按 count 加权：3×1.8 + 1×1.0 → 1.6（简单均值为 1.4，口径不同）", () => {
    const details = [
      { type: "主动", count: 3, cooldownRange: [5, 12] as [number, number], avgMultiplier: 1.8, description: "" },
      { type: "被动", count: 1, cooldownRange: [0, 0] as [number, number], avgMultiplier: 1.0, description: "" },
    ];
    expect(weightedSkillMultiplier(details)).toBeCloseTo(1.6, 12);
    // 简单均值对照（battle.ts 既有 avgSkillMultiplier 口径）
    const simple = details.reduce((s, d) => s + d.avgMultiplier, 0) / details.length;
    expect(simple).toBeCloseTo(1.4, 12);
  });

  it("无 skillDetails / count 全 0 → 1.0", () => {
    expect(weightedSkillMultiplier(undefined)).toBe(1.0);
    expect(weightedSkillMultiplier([])).toBe(1.0);
    expect(
      weightedSkillMultiplier([
        { type: "x", count: 0, cooldownRange: [0, 0] as [number, number], avgMultiplier: 3, description: "" },
      ])
    ).toBe(1.0);
  });
});

// ==================== 一致性自检（核心）：同型互打方向恒等 ====================

/**
 * 互打判定（与 Spec Scenario 同口径）：calcDamage 定单刀伤害，
 * A 先完成 ⇔ ceil(hp_B/perHit_A) < ceil(hp_A/perHit_B)。
 * 双方 speed 相等 → speedFactor 同值约掉，Power 差符号与胜负可比。
 */
function judgeAFirst(
  a: { attack: number; defense: number; hp: number; speed: number },
  b: { attack: number; defense: number; hp: number; speed: number },
  formulaType: "multiplicative" | "hybrid" | "reduction",
  coefficients: Record<string, number>
): "A" | "B" | "tie" {
  const perHitA = calcDamage(a.attack, b.defense, formulaType, coefficients);
  const perHitB = calcDamage(b.attack, a.defense, formulaType, coefficients);
  const turnsA = Math.ceil(b.hp / perHitA);
  const turnsB = Math.ceil(a.hp / perHitB);
  if (turnsA === turnsB) return "tie";
  return turnsA < turnsB ? "A" : "B";
}

function powerOf(
  x: { attack: number; defense: number; hp: number; speed: number },
  formulaType: "multiplicative" | "hybrid" | "reduction",
  stdAtk: number
): number {
  return computePowerStats(x, makeParams({ formulaType, stdAtk })).power;
}

describe("一致性自检 — multiplicative 严格恒等（≥5 组属性对，双方等速）", () => {
  const coeffs = { atkCoeff: 1.0, defCoeff: 0.5, K: 100 };
  const SPEED = 50;
  // 攻防互换 / 极攻 / 极防 / 均衡 / 小差距 / 互换（hp 同）
  const pairs: Array<{ name: string; a: [number, number, number]; b: [number, number, number] }> = [
    { name: "攻防互换", a: [100, 50, 1000], b: [50, 100, 1000] },
    { name: "极攻 vs 极防", a: [300, 10, 500], b: [50, 300, 2000] },
    { name: "极防 vs 极攻", a: [50, 300, 2000], b: [300, 10, 500] },
    { name: "均衡 vs 略低", a: [150, 150, 1500], b: [120, 120, 1200] },
    { name: "小差距", a: [160, 140, 1400], b: [150, 150, 1500] },
    { name: "互换（hp 同）", a: [120, 80, 900], b: [80, 120, 900] },
  ];

  it.each(pairs)("$name：sign(Power 差) 与 calcDamage 判先完成方一致", ({ a, b }) => {
    const A = { attack: a[0], defense: a[1], hp: a[2], speed: SPEED };
    const B = { attack: b[0], defense: b[1], hp: b[2], speed: SPEED };
    const winner = judgeAFirst(A, B, "multiplicative", coeffs);
    expect(winner).not.toBe("tie"); // fixture 设计避开平局
    const powerA = powerOf(A, "multiplicative", 5000);
    const powerB = powerOf(B, "multiplicative", 5000);
    expect(Math.abs(powerA - powerB)).toBeGreaterThan(0); // Power 可分辨
    expect(powerA > powerB).toBe(winner === "A");
  });

  it("确定性 LCG 随机组（30 组，量级差 <3 倍）：方向全一致", () => {
    let seed = 20260901;
    const next = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    let checked = 0;
    for (let i = 0; i < 40 && checked < 30; i++) {
      const U = (lo: number, hi: number) => lo + next() * (hi - lo);
      const A = {
        attack: Math.round(U(200, 1800)),
        defense: Math.round(U(20, 400)),
        hp: Math.round(U(500, 4500)),
        speed: SPEED,
      };
      const B = {
        attack: Math.round(U(200, 1800)),
        defense: Math.round(U(20, 400)),
        hp: Math.round(U(500, 4500)),
        speed: SPEED,
      };
      if (judgeAFirst(A, B, "multiplicative", coeffs) === "tie") continue;
      checked++;
      expect(
        powerOf(A, "multiplicative", 5000) > powerOf(B, "multiplicative", 5000)
      ).toBe(judgeAFirst(A, B, "multiplicative", coeffs) === "A");
    }
    expect(checked).toBe(30);
  });
});

describe("一致性自检 — hybrid 退化恒等（减伤常数 → Power² ∝ atk×hp）", () => {
  const coeffs = { atkCoeff: 1.0, defCoeff: 0.5 };
  const SPEED = 50;
  const pairs: Array<{ name: string; a: [number, number, number]; b: [number, number, number] }> = [
    { name: "高攻低血 vs 低攻高血", a: [240, 100, 1000], b: [100, 300, 2500] },
    { name: "反向往复", a: [300, 100, 1000], b: [100, 300, 2500] },
    { name: "同量级", a: [200, 100, 1000], b: [100, 300, 2500] },
  ];

  it.each(pairs)("$name：方向一致", ({ a, b }) => {
    const A = { attack: a[0], defense: a[1], hp: a[2], speed: SPEED };
    const B = { attack: b[0], defense: b[1], hp: b[2], speed: SPEED };
    const winner = judgeAFirst(A, B, "hybrid", coeffs);
    expect(winner).not.toBe("tie");
    expect(powerOf(A, "hybrid", 5000) > powerOf(B, "hybrid", 5000)).toBe(winner === "A");
  });
});

describe("一致性自检 — reduction 近似度量（≥20 组非极端对方向正确率 ≥80%）", () => {
  it("确定性 LCG 30 组（双方属性量级差 <3 倍，减伤不触 clamp）：正确率 ≥80%", () => {
    const coeffs = { atkCoeff: 1.0, defCoeff: 0.6 };
    const STD_ATK = 2400;
    const SPEED = 50;
    let seed = 42;
    const next = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    let correct = 0;
    let wrong = 0;
    for (let i = 0; i < 200 && correct + wrong < 30; i++) {
      const U = (lo: number, hi: number) => lo + next() * (hi - lo);
      // 非极端域：atk∈[900,2300] / def∈[400,1200] / hp∈[8000,24000]（双方各属性差 <3 倍）
      const A = {
        attack: Math.round(U(900, 2300)),
        defense: Math.round(U(400, 1200)),
        hp: Math.round(U(8000, 24000)),
        speed: SPEED,
      };
      const B = {
        attack: Math.round(U(900, 2300)),
        defense: Math.round(U(400, 1200)),
        hp: Math.round(U(8000, 24000)),
        speed: SPEED,
      };
      // 减伤不触底（def×defCoeff/stdAtk < 0.31）、单刀伤害不 clamp（atk−def×0.6 > 0）
      if (judgeAFirst(A, B, "reduction", coeffs) === "tie") continue;
      const powerA = powerOf(A, "reduction", STD_ATK);
      const powerB = powerOf(B, "reduction", STD_ATK);
      if ((powerA > powerB) === (judgeAFirst(A, B, "reduction", coeffs) === "A")) correct++;
      else wrong++;
    }
    expect(correct + wrong).toBe(30);
    expect(correct / (correct + wrong)).toBeGreaterThanOrEqual(0.8);
  });
});
