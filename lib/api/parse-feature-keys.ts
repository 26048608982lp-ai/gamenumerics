/**
 * parseFeatureKeys
 * 从引擎计算结果中解析 feature keys（纯函数）
 *
 * 双形态契约（DUAL-SHAPE-REMOVAL / T12 修正）：
 * - B 形态 = 引擎输出（计算字段 + _strategy/_anchors/decisions 回显）
 * - C 形态 = demo seed / DB 存量（仅顶层计算键，无下划线回显）
 * - 计算与引擎顶层回显的键读顶层（economy resourceTypes / progression progressionModules /
 *   level levelTypes / battle attributeDesign·skillFramework·damageSimulations / monetization paymentProducts·paidResources /
 *   gacha probabilityTable·strategy）
 * - intent-only 设计键读 _strategy（damageFormula）；consumptionSplit E1-2 起引擎根级直拷
 *   （读点双读：根级优先、_strategy 兜底存量并入形态）
 * - decisions 是引擎回显的合法顶层键
 * - A 形态（顶层非下划线 strategy/anchors 整对象包装）不解析 → 空产出
 */
import type { PlanningModuleType } from "@/lib/types/project";

export interface FeatureKey {
  key: string;
  name: string;
}

/**
 * 静态 feature key → 中文标题词典（单源）。
 * parseFeatureKeys 产出名称与详情页标题显示/落库共用此词典；
 * 动态键（progression/level 的 LLM 生成 id）不在词典内，显示层走 humanizeKey 兜底。
 */
export const FEATURE_KEY_NAMES: Record<string, string> = {
  resource_system: "资源体系定义",
  daily_budget: "每日产出预算表",
  consumption_distribution: "消耗分布",
  value_chain: "价值链与兑换率",
  progression_overview: "养成总览",
  time_budget: "养成时间预算",
  attribute_table: "属性表",
  damage_formula: "伤害公式",
  skill_system: "技能系统",
  combat_simulation: "战斗模拟",
  level_pacing: "推进节奏",
  reward_schedule: "奖励投放节奏",
  payment_products: "付费产品",
  paid_resources: "付费资源",
  gacha_system: "抽卡系统",
  payer_segment: "付费分层",
  battle_pass: "通行证",
  gacha_pool_config: "卡池配置",
};

export function parseFeatureKeys(
  data: Record<string, unknown>,
  mod: PlanningModuleType
): FeatureKey[] {
  const result: FeatureKey[] = [];
  const strategy = data._strategy as Record<string, unknown> | undefined;

  if (mod === "economy" && data.resourceTypes) {
    result.push({ key: "resource_system", name: FEATURE_KEY_NAMES.resource_system });
    result.push({ key: "daily_budget", name: FEATURE_KEY_NAMES.daily_budget });
    // consumptionSplit 双读（E1-2）：根级优先（引擎直拷位，值判断——缺省时键存在值为
    // undefined），_strategy 兜底（存量并入形态）
    if (data.consumptionSplit ?? strategy?.consumptionSplit) {
      result.push({ key: "consumption_distribution", name: FEATURE_KEY_NAMES.consumption_distribution });
    }
    result.push({ key: "value_chain", name: FEATURE_KEY_NAMES.value_chain });
  }

  if (mod === "progression" && Array.isArray(data.progressionModules)) {
    result.push({ key: "progression_overview", name: FEATURE_KEY_NAMES.progression_overview });
    for (const m of data.progressionModules as Array<{ id: string; name: string }>) {
      if (m.id && m.name) result.push({ key: m.id, name: m.name });
    }
    result.push({ key: "time_budget", name: FEATURE_KEY_NAMES.time_budget });
  }

  if (mod === "battle") {
    // attributeDesign/skillFramework 读顶层（B 引擎顶层输出 / C seed 顶层同键）；
    // damageFormula 为 intent-only 设计键（引擎顶层输出 damageFormulaFramework，键名不同）→ 读 _strategy
    if (data.attributeDesign) result.push({ key: "attribute_table", name: FEATURE_KEY_NAMES.attribute_table });
    if (data.damageSimulations || strategy?.damageFormula) result.push({ key: "damage_formula", name: FEATURE_KEY_NAMES.damage_formula });
    if (data.skillFramework) result.push({ key: "skill_system", name: FEATURE_KEY_NAMES.skill_system });
    result.push({ key: "combat_simulation", name: FEATURE_KEY_NAMES.combat_simulation });
  }

  if (mod === "level" && Array.isArray(data.levelTypes)) {
    result.push({ key: "level_pacing", name: FEATURE_KEY_NAMES.level_pacing });
    for (const t of data.levelTypes as Array<{ id: string; name: string }>) {
      if (t.id && t.name) result.push({ key: t.id, name: `${t.name}配置` });
    }
    result.push({ key: "reward_schedule", name: FEATURE_KEY_NAMES.reward_schedule });
  }

  if (mod === "monetization") {
    // paymentProducts/paidResources 读顶层（B 引擎顶层回显 strategy 原值 / C seed 顶层同键）
    if (data.paymentProducts) result.push({ key: "payment_products", name: FEATURE_KEY_NAMES.payment_products });
    if (data.paidResources) result.push({ key: "paid_resources", name: FEATURE_KEY_NAMES.paid_resources });
    result.push({ key: "gacha_system", name: FEATURE_KEY_NAMES.gacha_system });
    result.push({ key: "payer_segment", name: FEATURE_KEY_NAMES.payer_segment });
    const decisions = data.decisions as Record<string, unknown> | undefined;
    if (
      decisions?.monetizationModel === "battle_pass" ||
      decisions?.monetizationModel === "mixed"
    ) {
      result.push({ key: "battle_pass", name: FEATURE_KEY_NAMES.battle_pass });
    }
  }

  if (mod === "gacha") {
    // B 形态：引擎顶层输出 probabilityTable + strategy（resolved 版，gacha.ts computeGachaFromIntent）；
    // _strategy 兼容既有 B 形态回显惯例。空 gacha: {}（demo C 形态）不出卡
    if (data.probabilityTable || data.strategy || strategy) {
      result.push({ key: "gacha_pool_config", name: FEATURE_KEY_NAMES.gacha_pool_config });
    }
  }

  return result;
}
