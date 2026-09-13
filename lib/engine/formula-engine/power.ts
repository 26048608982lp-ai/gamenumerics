import type { BattleDesignIntent } from "./types";

/**
 * W0 战力模型 v2：解析 EHP×EDPS 战力单源（纯函数，零 IO / 零 LLM / 零 React/Next/Supabase 依赖）。
 *
 * 1V1 互打解析恒等：A 必胜 ⇔ DPS_A×hp_A > DPS_B×hp_B——战力公式由此推导，非拟合。
 *
 * **战力可信度按公式型分级**：
 * - multiplicative / hybrid：严格度量。减伤与对方属性变量分离（hybrid 减伤为常数），
 *   sign(√(EDPS×EHP) 差) 与 calcDamage 互打判定的胜负方向严格一致；
 * - reduction：近似度量。减伤比例依赖对方攻击（变量不分离，Spec 审查反例：极端攻防互换
 *   配置可翻转），方向大体正确、极端配置可翻转（单测口径：非极端属性对方向正确率 ≥80%）。
 *
 * 属性键纪律：一切 level_1/level_max/growthTable 键访问必须经 `normalizeAttrKey` 归一
 * （intent 侧大写 ATK/DEF/HP/SPD + 特殊键小写，引擎结构层 id 小写）——禁裸读大写键
 * （否则核心四维全体缺键 → 静默零战力）。
 */

export type PowerFormulaType = BattleDesignIntent["strategy"]["damageFormula"]["type"];

export interface PowerFormulaParams {
  formulaType: PowerFormulaType;
  /** calcDamage 同款兜底链：atkCoeff→attackCoefficient→1.0 / defCoeff→defenseCoefficient→0.5 / K→100 */
  coefficients: Record<string, number>;
  /** 技能平均倍率（powerProfile 口径：skillDetails 按 count 加权均值，无则 1.0） */
  skillMultiplier: number;
  /** 暴击总倍率，缺省 1.5 */
  critDmgMult?: number;
  /** 标准锚：满级标准攻击（growthTable 末行 attack），减法式减伤用 */
  stdAtk: number;
  /** 标准锚：满级标准速度（growthTable 末行 speed） */
  stdSpeed: number;
}

export interface PowerStats {
  edps: number;
  ehp: number;
  power: number;
  /** 每点属性的战力增量（+1 数值微分）——「属性实际价值表」 */
  attrMarginalValues: Record<string, number>;
}

/** 大写 intent 键 → 引擎结构层小写 id（单源映射，Spec W0 P1 修正） */
const UPPER_KEY_MAP: Record<string, string> = {
  ATK: "attack",
  DEF: "defense",
  HP: "hp",
  SPD: "speed",
};

/** 属性键归一单源：ATK→attack / DEF→defense / HP→hp / SPD→speed / 其余小写原样 */
export function normalizeAttrKey(key: string): string {
  return UPPER_KEY_MAP[key] ?? key.toLowerCase();
}

/** 参与 power 计价与边际价值微分的属性键（crit 百分数语义） */
const POWER_ATTR_KEYS = ["attack", "defense", "hp", "speed", "crit"] as const;

type PowerAttrs = Record<string, number>;

/** 属性 record 整体归一：输入键（可能大写 ATK…）经 normalizeAttrKey 后建索引 */
function normalizeAttrs(attrs: Record<string, number>): PowerAttrs {
  const out: PowerAttrs = {};
  for (const key of Object.keys(attrs)) {
    out[normalizeAttrKey(key)] = attrs[key];
  }
  return out;
}

/** 属性读取：非数值视为缺失（undefined），防御 JSON 脏数据 */
function readAttr(attrs: PowerAttrs, key: string): number | undefined {
  const raw = attrs[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** critExpect = 1 + (crit/100)×(critDmgMult−1)；crit 缺失/≤0 → 1（不参与暴击计价） */
function critExpectOf(crit: number | undefined, critDmgMult: number): number {
  if (crit === undefined || crit <= 0) return 1;
  return 1 + (crit / 100) * (critDmgMult - 1);
}

/** speedFactor = speed/(speed+stdSpeed)；speed 缺失/≤0 → 1（不参与速度计价，不惩罚） */
function speedFactorOf(speed: number | undefined, stdSpeed: number): number {
  if (speed === undefined || speed <= 0 || stdSpeed <= 0) return 1;
  return speed / (speed + stdSpeed);
}

/** EHP 减伤乘子（三型，PLAN_REVIEW P1 修正：全部为「减伤越强等效生命越高」方向） */
function mitigationOf(
  defense: number,
  params: PowerFormulaParams
): number {
  const defCoeff =
    params.coefficients.defCoeff ?? params.coefficients.defenseCoefficient ?? 0.5;
  if (params.formulaType === "multiplicative") {
    const K = params.coefficients.K ?? 100;
    return 1 + (defense * defCoeff) / K;
  }
  if (params.formulaType === "reduction") {
    // 除法形态：减伤比例是承伤乘子，等效生命取其倒数；clamp 0.1 防御溢出
    if (params.stdAtk <= 0) return 1; // 无标准锚 → 不计价（退化为裸 hp）
    return 1 / Math.max(0.1, 1 - (defense * defCoeff) / params.stdAtk);
  }
  // hybrid：固定减免 → EHP 线性于 hp
  return 1 / (1 - Math.min(defCoeff, 0.99));
}

/** 核心三量（不含边际）：EDPS / EHP / Power=√(EDPS×EHP)，全零属性 → 0 不产 NaN */
function computeCore(rawAttrs: Record<string, number>, params: PowerFormulaParams) {
  const attrs = normalizeAttrs(rawAttrs);
  const atkCoeff =
    params.coefficients.atkCoeff ?? params.coefficients.attackCoefficient ?? 1.0;
  const critExpect = critExpectOf(readAttr(attrs, "crit"), params.critDmgMult ?? 1.5);
  const speedFactor = speedFactorOf(readAttr(attrs, "speed"), params.stdSpeed);
  const attack = readAttr(attrs, "attack") ?? 0;
  const defense = readAttr(attrs, "defense") ?? 0;
  const hp = readAttr(attrs, "hp") ?? 0;

  // 已知口径 caveat（code-review P3）：calcDamage hybrid 型含 flatBonus（(atk+flatBonus)×…），
  // 本 EDPS 不计 flatBonus——flatBonus≠0 时 hybrid「严格恒等」退化为近似；flatBonus 缺省 0，主流配置不受影响
  const edps = attack * atkCoeff * params.skillMultiplier * critExpect * speedFactor;
  const ehp = hp * mitigationOf(defense, params);
  const power = Math.sqrt(Math.max(0, edps * ehp));
  return { edps, ehp, power };
}

/**
 * 解析战力计算单源（Spec W0 Requirement 1）。
 * 属性边际价值：对 attack/defense/hp/speed/crit 逐属性 +1 数值微分
 * （Power(attrs+1) − Power(attrs)）——产出「属性实际价值表」。
 */
export function computePowerStats(
  attrs: Record<string, number>,
  params: PowerFormulaParams
): PowerStats {
  const base = computeCore(attrs, params);
  const normalized = normalizeAttrs(attrs);
  const attrMarginalValues: Record<string, number> = {};
  for (const key of POWER_ATTR_KEYS) {
    const bumped: PowerAttrs = { ...normalized };
    bumped[key] = (readAttr(normalized, key) ?? 0) + 1;
    attrMarginalValues[key] = computeCore(bumped, params).power - base.power;
  }
  return { edps: base.edps, ehp: base.ehp, power: base.power, attrMarginalValues };
}

/** skillDetails 形状（intent 与 ComputedBattleData.skillFramework 共用子集，其余字段透传不读） */
export interface SkillDetailLike {
  count: number;
  avgMultiplier: number;
  [key: string]: unknown;
}

/**
 * 技能倍率（powerProfile 口径）：skillDetails 按 count 加权均值；无 skillDetails / count 全 0 → 1.0。
 * 命名与 battle.ts 既有 avgSkillMultiplier（简单均值，缺省 1.5，damageSimulations 展示用）区分
 * ——两处口径不同且不在本波次统一（Spec W0 Requirement 3）。
 */
export function weightedSkillMultiplier(
  skillDetails?: SkillDetailLike[]
): number {
  if (!skillDetails || skillDetails.length === 0) return 1.0;
  const totalCount = skillDetails.reduce((s, d) => s + (d.count || 0), 0);
  if (totalCount <= 0) return 1.0;
  return (
    skillDetails.reduce((s, d) => s + d.avgMultiplier * (d.count || 0), 0) / totalCount
  );
}
