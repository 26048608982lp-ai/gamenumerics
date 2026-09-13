import { describe, it, expect } from "vitest";
import { simulateBattle } from "../battle-sim";

// 面板锚点取自外包项目导表-英雄 L1（攻击100/体力500/暴击率0.1/暴伤1.3/攻速1）
// 与 enemy/等级成长 Level0 首行（hp300/damage5）
const PLAYER_L1 = { attack: 100, hp: 500, critRate: 0.1, critDamage: 1.3, attackSpeed: 1 };
const ENEMY_L0_R1 = { hp: 300, damage: 5, blocking: 10 };

describe("simulateBattle — 面板对拼模型", () => {
  it("期望口径：击杀刀数/被击刀数/killRatio/DPS 正确", () => {
    // 期望每刀 = 100 × (1 + 0.1×0.3) = 103；击杀 300hp → 3 刀；被击 = ceil(500/5)=100 刀
    const r = simulateBattle({ player: PLAYER_L1, enemy: ENEMY_L0_R1 });
    expect(r.playerHitsToKill).toBe(3);
    expect(r.enemyHitsToKillPlayer).toBe(100);
    expect(r.killRatio).toBeCloseTo(100 / 3, 2);
    expect(r.verdict).toBe("easy");
    expect(r.playerDps).toBeCloseTo(103, 1);
    expect(r.assumptions.length).toBeGreaterThan(0);
    expect(r.winRate).toBeUndefined();
  });

  it("四档判定：balanced / tight / impossible", () => {
    // balanced：ratio ∈ [1.3, 2)——被击 4 刀/击杀 3 刀 = 1.33（damage 69 下 hp=250 → ceil(250/69)=4）
    expect(
      simulateBattle({ player: { ...PLAYER_L1, hp: 250, attack: 100 }, enemy: { hp: 300, damage: 69 } }).verdict
    ).toBe("balanced");
    // tight：ratio ∈ [1, 1.3)——击杀 3 刀/被击 3 刀 = 1.0（damage 100 下 hp=250 → ceil(250/100)=3）
    expect(
      simulateBattle({ player: { ...PLAYER_L1, hp: 250 }, enemy: { hp: 300, damage: 100 } }).verdict
    ).toBe("tight");
    // impossible：ratio < 1
    expect(
      simulateBattle({ player: { ...PLAYER_L1, hp: 50 }, enemy: { hp: 300, damage: 100 } }).verdict
    ).toBe("impossible");
  });

  it("Monte Carlo：必胜面板胜率 1，必败面板胜率 0（注入确定性随机源）", () => {
    const always = (v: number) => () => v;
    const win = simulateBattle({
      player: PLAYER_L1,
      enemy: ENEMY_L0_R1,
      simulations: 200,
      random: always(0.99), // 永不暴击也碾压
    });
    expect(win.winRate).toBe(1);
    const lose = simulateBattle({
      player: { ...PLAYER_L1, hp: 10 },
      enemy: { hp: 1_000_000, damage: 1000 },
      simulations: 200,
      random: always(0.0), // 每刀都暴击也打不过
    });
    expect(lose.winRate).toBe(0);
  });

  it("Monte Carlo：临界面板胜率介于 0 与 1 之间", () => {
    // 攻 100 敌 hp 200：不暴击 2 刀，暴击 2 刀（130×2=260 也够）——换临界：敌 hp 260
    // 不暴击 3 刀 / 暴击 2 刀；敌 damage 100、玩家 hp 200：2 刾死玩家 → 暴击两次才赢
    const r = simulateBattle({
      player: { ...PLAYER_L1, hp: 200 },
      enemy: { hp: 260, damage: 100 },
      simulations: 1000,
    });
    expect(r.winRate!).toBeGreaterThan(0);
    expect(r.winRate!).toBeLessThanOrEqual(1);
  });

  it("非法面板抛错", () => {
    expect(() => simulateBattle({ player: { ...PLAYER_L1, attack: 0 }, enemy: ENEMY_L0_R1 })).toThrow();
    expect(() => simulateBattle({ player: PLAYER_L1, enemy: { hp: 0, damage: 5 } })).toThrow();
  });

  it("成长咬合样例：玩家按成长表推进，敌人档位提高后 ratio 收窄", () => {
    // L1 玩家 vs Level9 末行敌人（hp 6353/damage 245）
    const hard = simulateBattle({ player: PLAYER_L1, enemy: { hp: 6353, damage: 245 } });
    expect(hard.verdict).toBe("impossible");
    // 满级玩家（导表-英雄 L60 近似：攻击 ~5 倍）vs 同一敌人
    const grown = simulateBattle({
      player: { ...PLAYER_L1, attack: 500, hp: 2500 },
      enemy: { hp: 6353, damage: 245 },
    });
    expect(grown.killRatio).toBeGreaterThan(hard.killRatio);
  });
});
