import type { ComputedBattleData } from "@/lib/types/planning";
import { calcDamage } from "./battle";
import {
  computeGrowthProjection,
  type ProjectionPace,
} from "./growth-projection";

/**
 * 难度咬合引擎（growth-followups-trio Re2，D3/D4）：纯函数镜像法——
 * 敌人属性 = 玩家画像锚点属性 × 档位系数（镜像守恒），消费 c1 导出的 calcDamage
 * 计算玩家击杀刀数并出咬合判定。无 LLM、无随机、无外部依赖。
 *
 * 玩家画像复用 computeGrowthProjection（import 复用，勿复制其逻辑）；
 * S8 存量兼容同型：结构层缺字段或属性构成无核心项 → 抛中文 Error（含「重新生成」
 * 指引词），面板层 try-catch 降级。
 * 类型出口沿 growth-projection 先例：本地定义 + formula-engine/index.ts 再导出，
 * 不注册进 ComputedPlanningData 联合。
 */

export interface MirrorTier {
  id: string;
  name: string;
  coefficient: number;
}

/** 入参：结构 4 字段 + 属性成长表 + 战斗节奏 + 伤害公式框架可选。调用层从完整 planningData 挑选传入——引擎不做弱类型 JSON 探测。 */
export type MirrorBattleInput = Pick<
  ComputedBattleData,
  | "systemSwitches"
  | "growthLines"
  | "attributeCategories"
  | "allocationMatrix"
  | "attributeGrowthTable"
  | "combatPacing"
> &
  Partial<Pick<ComputedBattleData, "damageFormulaFramework">> &
  // Review 修复（补充视角 2.1）：类型与运行时消费对齐——computeGrowthProjection 内部
  // 实际读取 lineScheduleEcho（线权重），projection-tools 等调用方传完整 confirmed，
  // 本类型此前声称「镜像不需要调度」与运行时行为矛盾
  Partial<Pick<ComputedBattleData, "lineScheduleEcho">>;

export interface MirrorOptions {
  /** 难度档位（默认 TIERS_DEFAULT 四档） */
  tiers?: Array<MirrorTier>;
  /** 推演锚点（天，≥1；默认同投影 [7, 30, 90, 180]） */
  anchors?: number[];
  pace?: ProjectionPace;
  /** 目标刀数一级来源（调用层直供，clamp ≥1） */
  targetTurns?: number;
  /** 二级来源：调用层从弱类型 data._anchors.hpAtkRatio 读出后传入 */
  hpAtkRatioHint?: number;
  /** 公式类型一级来源 */
  formulaType?: "reduction" | "multiplicative" | "hybrid";
}

export interface DifficultyMirrorEntry {
  day: number;
  tierId: string;
  /** 投影输出 attributes × coefficient 逐属性缩放（镜像守恒） */
  enemyAttributes: Array<{ id: string; name: string; value: number }>;
  /** 玩家击杀该敌人所需刀数 = ⌈enemyHP / perHit⌉，clamp ≥1 */
  playerKillTurns: number;
  /** ratio = playerKillTurns/targetTurns：<0.7 under / ≤1.4 aligned / >1.4 over */
  alignment: "under" | "aligned" | "over";
}

export interface DifficultyMirrorResult {
  moduleType: "difficulty-mirror";
  targetTurns: number;
  tiers: Array<MirrorTier>;
  entries: DifficultyMirrorEntry[];
}

/** 默认四档（D3）：轻松 0.85 / 普通 1.0 / 困难 1.25 / 噩梦 1.5 */
export const TIERS_DEFAULT: MirrorTier[] = [
  { id: "easy", name: "轻松", coefficient: 0.85 },
  { id: "normal", name: "普通", coefficient: 1.0 },
  { id: "hard", name: "困难", coefficient: 1.25 },
  { id: "nightmare", name: "噩梦", coefficient: 1.5 },
];

/**
 * 从 DifficultyMirrorBlock 迁移的口径单源（agent-p2-tools 契约 D），UI 与
 * agent 工具同源消费。弱类型读取 data.enemyStrengthBaseline（questionnaire-ia
 * W2：ComputedBattleData 锚点透传，lenient 0.75 / standard 1.0 / oppressive
 * 1.2）。作为 tiers 档位系数的全局乘数（与 TIERS_DEFAULT 正交），非法值
 * （非数值 / 非有限 / ≤0）按缺省 1.0 忽略。
 */
export function readEnemyStrengthBaseline(data: unknown): number {
  const value = (data as Record<string, unknown>)?.enemyStrengthBaseline;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 1.0;
}

/**
 * 从 DifficultyMirrorBlock 迁移的口径单源（agent-p2-tools 契约 D），UI 与
 * agent 工具同源消费。弱类型读取 data._anchors.hpAtkRatio（先例
 * level-frameworks.ts isRecord + 数值校验），非对象 / 非数值 / 非有限 / ≤0
 * → undefined。
 */
export function readHpAtkRatioHint(data: unknown): number | undefined {
  const anchors = (data as Record<string, unknown>)?._anchors;
  if (typeof anchors !== "object" || anchors === null) return undefined;
  const ratio = (anchors as Record<string, unknown>).hpAtkRatio;
  return typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0
    ? ratio
    : undefined;
}

/**
 * 从 DifficultyMirrorBlock 迁移的组合口径单源（agent-p2-tools 契约 D），UI 与
 * agent 工具同源消费：baseline = readEnemyStrengthBaseline(data)；baseline
 * === 1.0 时原样返回 tiers（同引用——受控编辑仍基于用户原始系数），否则逐档
 * coefficient × baseline（深档题全局乘数与 TIERS_DEFAULT 正交）。仅作用于
 * 引擎入参，不回写 tiers 状态（组件渲染仍持原始 tiers）。
 */
export function resolveEffectiveTiers(tiers: MirrorTier[], data: unknown): MirrorTier[] {
  const baseline = readEnemyStrengthBaseline(data);
  return baseline === 1.0
    ? tiers
    : tiers.map((tier) => ({
        ...tier,
        coefficient: tier.coefficient * baseline,
      }));
}

/** 战斗节奏 → 目标刀数末级映射；未知 pacing 走 standard */
const PACING_TARGET_TURNS: Record<string, number> = {
  fast: 6,
  standard: 10,
  slow: 14,
};

/**
 * 目标刀数三级解析：options.targetTurns > options.hpAtkRatioHint >
 * combatPacing 映射 {fast:6,standard:10,slow:14}；最终 clamp ≥1。
 */
function resolveTargetTurns(options: MirrorOptions | undefined, combatPacing: string): number {
  const raw =
    options?.targetTurns ??
    options?.hpAtkRatioHint ??
    PACING_TARGET_TURNS[combatPacing] ??
    PACING_TARGET_TURNS.standard;
  if (!Number.isFinite(raw)) return PACING_TARGET_TURNS.standard;
  return Math.max(1, raw);
}

const FORMULA_TYPES = ["reduction", "multiplicative", "hybrid"] as const;
type FormulaType = (typeof FORMULA_TYPES)[number];

/**
 * 公式类型三级解析：options.formulaType > damageFormulaFramework 的
 * description/baseFormula 文本匹配 > 默认 'reduction'。
 */
function resolveFormulaType(
  options: MirrorOptions | undefined,
  framework: ComputedBattleData["damageFormulaFramework"] | undefined
): FormulaType {
  if (options?.formulaType) return options.formulaType;
  const text = `${framework?.description ?? ""} ${framework?.baseFormula ?? ""}`;
  for (const t of FORMULA_TYPES) {
    if (text.includes(t)) return t;
  }
  return "reduction";
}

/** 咬合判定阈值（Spec §Re2）：ratio<0.7 under / ≤1.4 aligned / >1.4 over */
function judgeAlignment(ratio: number): DifficultyMirrorEntry["alignment"] {
  if (ratio < 0.7) return "under";
  return ratio <= 1.4 ? "aligned" : "over";
}

export function computeDifficultyMirror(
  battle: MirrorBattleInput,
  options?: MirrorOptions
): DifficultyMirrorResult {
  // 结构层字段存在性校验（S8 存量兼容，与 growth-projection 同型抛错）
  const missingFields = (
    ["systemSwitches", "growthLines", "attributeCategories", "allocationMatrix"] as const
  ).filter((key) => battle[key] === undefined || battle[key] === null);
  if (missingFields.length > 0) {
    throw new Error(
      `battle 数据缺少结构层字段（${missingFields.join("、")}），无法生成难度咬合镜像；` +
        `旧版方案请在战斗规划模块重新生成以补全结构层`
    );
  }

  // 玩家画像（规则与逻辑全部由投影引擎承载，本函数只读其输出）
  const projection = computeGrowthProjection(battle, {
    ...(options?.anchors !== undefined ? { anchors: options.anchors } : {}),
    ...(options?.pace !== undefined ? { pace: options.pace } : {}),
  });

  const formulaType = resolveFormulaType(options, battle.damageFormulaFramework);
  // coefficients 缺失走引擎默认参数集（calcDamage 内部 ?? 兜底链，零拷贝）
  const coefficients = battle.damageFormulaFramework?.coefficients ?? {};
  const targetTurns = resolveTargetTurns(options, battle.combatPacing);
  const tiers = options?.tiers ?? TIERS_DEFAULT;

  const entries: DifficultyMirrorEntry[] = [];
  for (const anchor of projection.anchors) {
    const attrs = anchor.attributes;
    const atkAttr = attrs.find((a) => a.id === "attack");
    const hpAttr = attrs.find((a) => a.id === "hp");
    // 属性构成缺核心项 → 无法镜像判定（攻击定口径、生命定敌人血量），同型抛错交面板降级
    if (!atkAttr) {
      throw new Error(
        `玩家画像属性构成缺少攻击（attack）项，无法确定伤害口径；` +
          `请在战斗规划问卷确认属性分层包含攻击后重新生成方案`
      );
    }
    if (!hpAttr) {
      throw new Error(
        `玩家画像属性构成缺少生命（hp）项，无法计算击杀刀数；` +
          `请在战斗规划问卷确认属性分层包含生命后重新生成方案`
      );
    }

    const defenseAttr = attrs.find((a) => a.id === "defense");

    for (const tier of tiers) {
      const enemyAttributes = attrs.map((a) => ({
        id: a.id,
        name: a.name,
        value: a.value * tier.coefficient,
      }));
      const perHit = calcDamage(
        atkAttr.value,
        (defenseAttr?.value ?? 0) * tier.coefficient,
        formulaType,
        coefficients
      );
      // S8 同型防护：系数异常（atkCoeff=0 / defCoeff 为负等）致单次伤害 ≤0 或非有限时，
      // ⌈hp/perHit⌉ 产生 Infinity/NaN 使咬合判定失真——抛中文 Error 交面板 try-catch 降级
      if (perHit <= 0 || !Number.isFinite(perHit)) {
        throw new Error(
          `伤害公式计算出的单次命中伤害无效（${perHit}），无法生成难度咬合镜像；` +
            `请检查战斗方案的伤害公式系数配置后重新生成方案`
        );
      }
      const rawTurns = Math.ceil((hpAttr.value * tier.coefficient) / perHit);
      const playerKillTurns = Math.max(1, rawTurns);
      entries.push({
        day: anchor.day,
        tierId: tier.id,
        enemyAttributes,
        playerKillTurns,
        alignment: judgeAlignment(playerKillTurns / targetTurns),
      });
    }
  }

  return {
    moduleType: "difficulty-mirror",
    targetTurns,
    tiers,
    entries,
  };
}
