import type { AnyDesignIntent } from "./types";
import { computeBattleFromIntent } from "./battle";
import { computeEconomyFromIntent } from "./economy";
import { computeProgressionFromIntent, computeTimeBudget } from "./progression";
export type { ProgressionLevelRow, ProgressionModuleResult, TimeBudgetRow, TimeBudgetModule, TimeBudgetResult, KeyMilestoneTimelineEntry } from "./progression";
export { computeTimeBudget };
export { computeGrowthProjection, computePowerAtDay, HORIZON_DAY } from "./growth-projection";
export type { ProjectionOptions, ProjectionPace, ComputedGrowthProjection, GrowthProjectionBattle } from "./growth-projection";
// 玩家体验预期总表（planning-four-expectation W3-A）：四模块 confirmed 产物聚合推演，
// 第五类产物而非第五模块（无 LLM 生成步骤），独立导出先例不入 ComputedPlanningData 联合 / intent 路由
export {
  computeExperienceExpectation,
  buildExperienceExpectationInput,
} from "./experience-expectation";
export type {
  ExperienceExpectationInput,
  ExperienceExpectationSources,
  ExperienceExpectationAnchor,
  ComputedExperienceExpectation,
} from "./experience-expectation";
// 配置表草稿导出（V10-W3 T2）：confirmed 产物 → 工作区规范化表草稿 + configTableRefs
// 单源派生，独立导出先例不入 intent 路由（export_deliverable / 总表 refs 同源消费）
export {
  deriveLevelTable,
  deriveBattleMatrixTable,
  deriveConfigTableDrafts,
} from "./config-table-export";
export type {
  ConfigTableDraft,
  ConfigTableRow,
  ConfigTableModule,
  ConfigTableRefEntry,
  ConfigTableUnavailableEntry,
  ConfigTableRefs,
  ConfigTableSources,
  ConfigTableDraftBundle,
} from "./config-table-export";
// W0 战力模型 v2：解析战力单源（powerProfile / 推演共用），独立导出先例不入 intent 路由
export { computePowerStats, normalizeAttrKey, weightedSkillMultiplier } from "./power";
export type { PowerFormulaParams, PowerFormulaType, PowerStats } from "./power";
// 难度咬合镜像（growth-followups-trio Re2）：类型本地定义 + barrel 再导出先例，不入 ComputedPlanningData 联合
// 契约 D 三导出（agent-p2-tools）：弱读+组合口径单源，从 DifficultyMirrorBlock 迁移，UI 与 agent 工具同源消费
export {
  computeDifficultyMirror,
  TIERS_DEFAULT,
  readEnemyStrengthBaseline,
  readHpAtkRatioHint,
  resolveEffectiveTiers,
} from "./difficulty-mirror";
export type {
  MirrorBattleInput,
  MirrorOptions,
  MirrorTier,
  DifficultyMirrorEntry,
  DifficultyMirrorResult,
} from "./difficulty-mirror";
// 战斗模拟（agent 工作区 battle_simulate 工具的引擎侧）：面板对拼模型，独立导出先例不入 intent 路由
export { simulateBattle } from "./battle-sim";
export type {
  BattleSimPlayerPanel,
  BattleSimEnemyPanel,
  BattleSimInput,
  BattleSimResult,
  BattleVerdict,
} from "./battle-sim";
// 分层概率池抽取（agent simulate_gacha 工具 tiers 模式）：无保底分层结构
export { simulateTieredDraws, runGachaSimulation } from "./gacha";
export type { TieredPoolTier, TierQuantiles, TieredPoolResult } from "./gacha";
// 迷你表达式求值器（apply_curve 锚点公式 / eval_formula 对账）：四则+幂+括号+中文变量
export { evalExpression } from "./expression";
import { computeLevelFromIntent } from "./level";
import { computeMonetizationFromIntent } from "./monetization";
import { computeGachaFromIntent } from "./gacha";
import { computeGameFrameworkFromIntent } from "./game-framework";

export type { AnyDesignIntent, BattleDesignIntent, EconomyDesignIntent, ProgressionDesignIntent, LevelDesignIntent, MonetizationDesignIntent, GachaDesignIntent, GameFrameworkDesignIntent, KeyMilestone } from "./types";
// ComputedGameFrameworkData 定义在 lib/types/planning（T1 冻结契约），此处对齐
// computeGrowthProjection 的独立导出先例供路由/展示层直接消费
export { computeGameFrameworkFromIntent };
export type { ComputedGameFrameworkData, GenreStyleCard } from "@/lib/types/planning";
// Re.E1-1：gacha computed 单源类型（不入 ComputedPlanningData 联合，difficulty-mirror 先例）
export type { ComputedGachaData } from "@/lib/types/planning";

/**
 * 从设计意图计算完整数值
 * @param intent LLM 输出的设计意图 + 锚点
 * @returns 完整的规划数据（与现有 planning_data 格式兼容）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function computeFromIntent(intent: AnyDesignIntent): Record<string, unknown> {
  let result: unknown;
  switch (intent.moduleType) {
    case "battle":
      result = computeBattleFromIntent(intent);
      break;
    case "economy":
      result = computeEconomyFromIntent(intent);
      break;
    case "progression":
      result = computeProgressionFromIntent(intent);
      break;
    case "level":
      result = computeLevelFromIntent(intent);
      break;
    case "monetization":
      result = computeMonetizationFromIntent(intent);
      break;
    case "gacha":
      result = computeGachaFromIntent(intent);
      break;
    case "game-framework":
      result = computeGameFrameworkFromIntent(intent);
      break;
    default:
      throw new Error(`Unknown module type: ${(intent as { moduleType: string }).moduleType}`);
  }
  const computed = result as Record<string, unknown>;
  // 保留原始策略、锚点和决策供 UI 展示（并支持前端行内编辑后重建 intent 重算）
  if (intent.strategy) computed._strategy = intent.strategy;
  // economy 的 consumptionSplit 回显位 = computed 根级直拷（economy.ts，E1-2 起），
  // 不再并入 _strategy——下游读点一律「根级优先、_strategy 兜底」双读兼容存量
  if ("anchors" in intent && intent.anchors) computed._anchors = intent.anchors;
  // Re1 双键回显（growth-followups-trio c2）：battle 结构决策 / progression 关键节点
  // 为 intent 根级键，不回显则行内编辑/参数修订重算会静默回落默认结构、丢失里程碑。
  // 缺失时不写键（条件判空，严于"写 undefined"），旧数据兼容行为不变。
  if (intent.moduleType === "battle" && intent.structuralDecisions) {
    computed._structuralDecisions = intent.structuralDecisions;
  }
  if (intent.moduleType === "progression" && intent.keyMilestones) {
    computed._keyMilestones = intent.keyMilestones;
  }
  // Re.E1-4 provenance 回显：intent 根级 summary/reasoning（全模块通用可选键）条件写入
  // `_`+原键名（同 _strategy/_anchors 惯例），行内编辑重建经 rebuildIntentFromComputed
  // 对称上移——缺失时不写键（旧数据兼容行为不变）
  if ("summary" in intent && intent.summary) {
    computed._summary = intent.summary;
  }
  if ("reasoning" in intent && intent.reasoning) {
    computed._reasoning = intent.reasoning;
  }
  if ("decisions" in intent && intent.decisions && computed.decisions === undefined) {
    computed.decisions = intent.decisions;
  }
  return computed;
}

