/**
 * 战斗模拟 — 玩家面板 × 敌人面板的对拼模型（纯函数，零 IO/LLM）
 *
 * 针对外包肉鸽格斗项目实例化（2026-09-03 用户决策：替换通用难度曲线方案）。
 * 数据源：hero/成长表（攻击/体力/暴击率/暴击伤害/攻速/破防率）×
 * enemy/等级成长（hp/blocking/damage）。
 *
 * 模型边界（近似声明随结果返回，不静默）：
 * - 暴击按每刀独立判定，期望值 = attack × (1 + critRate × (critDamage - 1))
 * - 格挡/均衡量/弹反等格斗操作机制未建模——这是数值面板对拼模型，
 *   结论用于成长曲线咬合诊断，不用于单局胜负预测
 * - 敌人每刀伤害按面板 damage 恒定
 */

export interface BattleSimPlayerPanel {
  attack: number;
  hp: number;
  /** 暴击率，0~1 */
  critRate: number;
/** 暴击伤害倍率，如 1.3 */
  critDamage: number;
  /** 攻击速度（每秒刀数） */
  attackSpeed: number;
}

export interface BattleSimEnemyPanel {
  hp: number;
  /** 敌人每刀伤害 */
  damage: number;
  /** 格挡值（当前模型未消耗，仅随 assumptions 声明） */
  blocking?: number;
}

export interface BattleSimInput {
  player: BattleSimPlayerPanel;
  enemy: BattleSimEnemyPanel;
  /** Monte Carlo 局数；>0 时计算含暴击随机的胜率，默认 0 只算期望 */
  simulations?: number;
  /** 可注入随机源（测试确定性） */
  random?: () => number;
}

export type BattleVerdict = "easy" | "balanced" | "tight" | "impossible";

export interface BattleSimResult {
  /** 玩家击杀敌人所需刀数（期望口径，向上取整） */
  playerHitsToKill: number;
  /** 敌人击杀玩家所需刀数 */
  enemyHitsToKillPlayer: number;
  /** 被击刀数 / 击杀刀数：>1 玩家占优 */
  killRatio: number;
  verdict: BattleVerdict;
  /** 玩家期望每秒伤害 */
  playerDps: number;
  /** Monte Carlo 胜率（simulations>0 时存在，玩家先手口径） */
  winRate?: number;
  assumptions: string[];
}

/** verdict 阈值（killRatio 口径），随模型演进可调 */
const VERDICT_THRESHOLDS = { easy: 2, balanced: 1.3 } as const;

const ASSUMPTIONS = [
  "暴击按每刀独立判定；格挡/均衡量/弹反等格斗操作机制未建模",
  "敌人每刀伤害按面板恒定；玩家先手",
];

function expectedDamagePerHit(player: BattleSimPlayerPanel): number {
  return player.attack * (1 + player.critRate * (player.critDamage - 1));
}

export function simulateBattle(input: BattleSimInput): BattleSimResult {
  const { player, enemy, simulations = 0, random = Math.random } = input;

  if (player.attack <= 0 || player.hp <= 0 || enemy.hp <= 0 || enemy.damage <= 0) {
    throw new Error("面板数值必须为正：attack/hp（玩家）与 hp/damage（敌人）");
  }

  const expectedHit = expectedDamagePerHit(player);
  const playerHitsToKill = Math.ceil(enemy.hp / expectedHit);
  const enemyHitsToKillPlayer = Math.ceil(player.hp / enemy.damage);
  const killRatio = enemyHitsToKillPlayer / playerHitsToKill;

  const verdict: BattleVerdict =
    killRatio >= VERDICT_THRESHOLDS.easy
      ? "easy"
      : killRatio >= VERDICT_THRESHOLDS.balanced
        ? "balanced"
        : killRatio >= 1
          ? "tight"
          : "impossible";

  const result: BattleSimResult = {
    playerHitsToKill,
    enemyHitsToKillPlayer,
    killRatio: Number(killRatio.toFixed(3)),
    verdict,
    playerDps: Number((expectedHit * player.attackSpeed).toFixed(2)),
    assumptions: [...ASSUMPTIONS],
  };

  if (simulations > 0) {
    let wins = 0;
    for (let i = 0; i < simulations; i += 1) {
      // 逐刀模拟：双方按刀数推进，玩家先手；任一方血量归零即结束
      let enemyHpLeft = enemy.hp;
      let playerHpLeft = player.hp;
      while (enemyHpLeft > 0 && playerHpLeft > 0) {
        const crit = random() < player.critRate;
        enemyHpLeft -= player.attack * (crit ? player.critDamage : 1);
        if (enemyHpLeft <= 0) break;
        playerHpLeft -= enemy.damage;
      }
      if (enemyHpLeft <= 0 && playerHpLeft > 0) wins += 1;
    }
    result.winRate = Number((wins / simulations).toFixed(4));
  }

  return result;
}
