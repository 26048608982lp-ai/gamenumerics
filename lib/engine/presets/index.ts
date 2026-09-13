/**
 * 零 LLM 预设模板库 —— TEMPLATE-PATH 直算路径
 *
 * 问卷组合 → 预设 intent → computeFromIntent，0 次 LLM 调用。
 * 覆盖 gacha / level / economy / battle / game-framework（T3 起）；
 * 其余模块返回 null（回退现有 LLM 路径）。
 *
 * 域纯度约束：本目录源码禁止 import zod、lib/prompts、lib/ai、React、数据库；
 * 全部构建器为纯函数（相同输入相同输出，不变异入参）。
 * Zod 契约校验位点（均仅测试 import，引擎源码不 import prompts）：
 * lib/ai/__tests__/presets-contract.test.ts（T9）+
 * lib/engine/presets/__tests__/gacha-from-monetization.test.ts（T5a Spec 豁免）。
 */

import type { PlanningModuleType } from "@/lib/types/project";
import type { AnyDesignIntent } from "../formula-engine/types";
import { MODULE_PRESET_QUESTIONS } from "./questions";
import { buildGachaIntent } from "./gacha-presets";
import { buildLevelIntent } from "./level-presets";
import { buildEconomyIntent } from "./economy-presets";
import { buildBattleIntent } from "./battle-presets";
import { buildGameFrameworkIntent } from "./game-framework-presets";

/** 提供预设的模块 */
type CoveredModuleType = "gacha" | "level" | "economy" | "battle" | "game-framework";

/**
 * 模块 → intent 构建器。
 * 入参双轨：values = 按题目顺序排列的问卷值（gacha/level/economy 三参构建器解构用）；
 * answers = 原始问卷答案 Record（battle/game-framework 的自含校验构建器用）。
 * battle/game-framework 构建器自含键值域校验（battle 结构/体验/深档键、
 * game-framework 5 核心键——T5 问卷分工重组缩圈，6 体验键由品类默认表
 * 在构建器内部补全），可返回 null（builder 兜底分支）。
 */
const TEMPLATE_BUILDERS: Record<
  CoveredModuleType,
  (values: string[], answers: Record<string, string>) => AnyDesignIntent | null
> = {
  gacha: ([gachaStyle, pityIntensity, rateOpenness]) =>
    buildGachaIntent(gachaStyle, pityIntensity, rateOpenness),
  // level/economy 第 4 参为深档题（mainlinePacing / dailyPlaySessions），
  // 随 MODULE_PRESET_QUESTIONS 题序追加；构建器缺参时行为与深档题引入前一致
  level: ([difficultyCurve, progressionGate, levelVariety, mainlinePacing]) =>
    buildLevelIntent(difficultyCurve, progressionGate, levelVariety, mainlinePacing),
  economy: ([economyGoal, spendingFocus, resourceAcquisition, dailyPlaySessions]) =>
    buildEconomyIntent(economyGoal, spendingFocus, resourceAcquisition, dailyPlaySessions),
  battle: (_values, answers) => buildBattleIntent(answers),
  "game-framework": (_values, answers) => buildGameFrameworkIntent(answers),
};

/**
 * 解析问卷答案为预设模板 intent。
 *
 * 参数化语义：每道模块题的每个选项映射一组参数档位，
 * 全部合法选项组合均命中（正交参数，无"冷门组合"分支）。
 *
 * 返回 null 仅四种情况：
 * 1. 模块未覆盖（gacha/level/economy/battle/game-framework 之外）；
 * 2. 任一模块题答案值 ∉ 预设 options（= 自由文本）；
 * 3. 模块题未答全；
 * 4. 构建器自含校验未通过（battle/game-framework 构建器对 answers
 *    的判定键值域复检未过，回退 LLM 路径）。
 *
 * templateId 格式：`${moduleType}:${各题value按题目顺序连字符}`
 * （如 `gacha:character_focus-strict-transparent`）。
 * 通用题（gameType 等）不参与判定，多余 key 被忽略。
 */
export function resolveTemplateIntent(
  moduleType: PlanningModuleType,
  answers: Record<string, string>,
): { intent: AnyDesignIntent; templateId: string } | null {
  if (
    moduleType !== "gacha" &&
    moduleType !== "level" &&
    moduleType !== "economy" &&
    moduleType !== "battle" &&
    moduleType !== "game-framework"
  ) {
    return null; // 分支 1：模块未覆盖
  }
  const questions = MODULE_PRESET_QUESTIONS[moduleType];

  const values: string[] = [];
  for (const question of questions) {
    const answer = answers[question.key];
    if (answer === undefined) {
      return null; // 分支 3：模块题未答全
    }
    if (!question.options.includes(answer)) {
      return null; // 分支 2：自由文本（值 ∉ 预设 options）
    }
    values.push(answer);
  }

  const intent = TEMPLATE_BUILDERS[moduleType](values, answers);
  if (!intent) {
    return null; // 分支 4：构建器自含校验未通过
  }

  return {
    intent,
    templateId: `${moduleType}:${values.join("-")}`,
  };
}
