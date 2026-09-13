import type { ComputedBattleData } from "@/lib/types/planning";
import {
  computePowerStats,
  weightedSkillMultiplier,
  normalizeAttrKey,
  type PowerFormulaParams,
  type PowerFormulaType,
  type PowerStats,
} from "./power";

/**
 * 玩家成长推演引擎（W0 战力模型 v2 重写：属性先行正向链）。
 *
 * 正向链：day → 各线进度率 r_line(day) ∈ [0,1]（内部量，不输出）→ 属性供给
 * `level_1[c] + (level_max[c] − level_1[c]) × weightedProgress(c, day)` →
 * computePowerStats → Power(day)。
 *
 * 保留（W0 Spec）：lineStage 进度模型（hero 渐近 / equipment 品质插值 / skill、pet 深度）、
 * pace 形变（SHAPE_FACTOR/HERO_K 作用于进度率）、锚点过滤、结构字段缺失抛错语义；
 * 输出 progress 保持原始口径（hero=等级 / equipment=品质 / skill、pet=0-1）。
 *
 * 废弃：战力预算曲线（budget）——战力由属性决定，旧 log-power 预算模型移除。
 *
 * 纯函数：无 LLM、无随机、无外部依赖，相同输入产出相同输出（禁止 Date.now / Math.random）。
 * 派生面板数据源——不注册进 computeFromIntent intent 路由。
 *
 * S8 存量兼容：battle 旧 confirmedData（无结构字段/无 attributeGrowthTable）在函数开头
 * 校验后抛错，面板层（GrowthProjectionPanel）try-catch 降级为 null，不崩溃。
 */

export type ProjectionPace = "aggressive" | "standard" | "relaxed";

export interface ProjectionOptions {
  /** 推演锚点（天，≥1；默认 [7, 30, 90, 180]） */
  anchors?: number[];
  /** 节奏档位（默认 standard），作用于线进度速率 */
  pace?: ProjectionPace;
  /**
   * hero 等级上限（缺省 = 产物自描述：attributeGrowthTable 末行 level；无自描述
   * 回退 60——V8 W3-T3，battle 产物 maxLevel≠60 时 hero 轴口径与产物对齐）。
   * 作用于 heroStage 展示口径与 R7 权重 L 口径（heroLevel clamp 上限）。
   */
  heroMaxLevel?: number;
  /** 装备品质上限（默认 6，stage 展示口径） */
  equipmentMaxQuality?: number;
}

export interface ComputedGrowthProjection {
  moduleType: "growth-projection";
  anchors: Array<{
    day: number;
    totalPower: number;
    lines: Array<{
      id: string;
      name: string;
      type: string;
      progress: number;
      stage: string;
      power: number;
    }>;
    attributes: Array<{ id: string; name: string; value: number; sharePct: number }>;
  }>;
  pace: ProjectionPace;
}

/**
 * 推演入参：结构层 4 字段 + attributeGrowthTable（W0 五键必需，PLAN_REVIEW P1 修正；
 * 旧 confirmed_data 缺失时同结构字段语义抛错）。
 * 可选公式来源键（与 difficulty-mirror 的 Partial Pick 先例同构）：经
 * computeBattleFromIntent 产出的数据恒携带，用于 powerProfile 与投影末锚的同源一致；
 * 缺失时走引擎兜底（multiplicative + 默认系数链 + 技能倍率 1.0）。
 */
export type GrowthProjectionBattle = Pick<
  ComputedBattleData,
  | "systemSwitches"
  | "growthLines"
  | "attributeCategories"
  | "allocationMatrix"
  | "attributeGrowthTable"
> &
  Partial<
    Pick<
      ComputedBattleData,
      "damageFormulaFramework" | "skillFramework" | "lineScheduleEcho"
    >
  >;

// ==================== 默认参数（Spec Requirements） ====================

const DEFAULT_ANCHORS = [7, 30, 90, 180];
const DEFAULT_HERO_MAX_LEVEL = 60;
const DEFAULT_EQUIPMENT_MAX_QUALITY = 6;

/**
 * heroMaxLevel 缺省产物自描述（V8 W3-T3）：battle 产物 attributeGrowthTable 末行
 * `level`（= computeBattleFromIntent 的 totalLevels = intent anchors.maxLevel || 50，
 * 循环终值精确写入）——产物上唯一的等级上限自描述（powerProfile 无 levelMax 键）。
 * 缺失/非有限/<1（旧产物、外部构造）→ 回退 DEFAULT_HERO_MAX_LEVEL=60（向后兼容）。
 * computeGrowthProjection 与 computePowerAtDay 两消费位同源共用本解析（Spec P1-2：
 * 只改一处会使 battle.powerProfile（day=180 满级画像）与投影末锚 heroL 口径静默分叉）。
 */
function resolveHeroMaxLevel(battle: GrowthProjectionBattle): number {
  const table = battle.attributeGrowthTable;
  if (Array.isArray(table) && table.length > 0) {
    const last = table[table.length - 1] as Record<string, unknown> | undefined;
    const level = Number(last?.level);
    if (Number.isFinite(level) && level >= 1) return level;
  }
  return DEFAULT_HERO_MAX_LEVEL;
}
/** 推演地平线（天）：equipment/skill/pet 进度率在 day=180 处精确收敛到 1 */
export const HORIZON_DAY = 180;

/** 节奏档位 → 进度曲线幂形变因子（aggressive 凸进 / standard 线性 / relaxed 缓升） */
const SHAPE_FACTOR: Record<ProjectionPace, number> = {
  aggressive: 0.7,
  standard: 1,
  relaxed: 1.4,
};

/** hero 渐近曲线速率 k（随 pace） */
const HERO_K: Record<ProjectionPace, number> = {
  aggressive: 0.04,
  standard: 0.025,
  relaxed: 0.015,
};

/** 装备档内强化上限（品质连续值小数段 → 档内强化等级） */
const MAX_ENHANCE_PER_TIER = 10;
/** skill/pet 深度等级上限与升星星数上限 */
const DEPTH_MAX_LEVEL = 10;
const DEPTH_MAX_STARS = 5;

// ==================== V8 W2-T6b（R7）线贡献爬坡参数（单源导出常量）====================

/** 开放线性渐入级数：openAt ≤ L < openAt+RAMP 内 (L−openAt)/RAMP 线性爬坡（Spec R7 缺省 5） */
export const RAMP_LEVELS = 5;
/**
 * focus 线阶段内放大乘数：Spec R7 缺省 1.5（值域 [0.5,2] 为意图侧值域，W3 Zod 前置
 * 拒绝；引擎侧按缺省常量取值）。无 stages 声明时无 focus 放大 = 1。
 */
export const FOCUS_BOOST_DEFAULT = 1.5;
/**
 * unlock 档位阶跃增益：每档 +0.2 线性累计（Orchestrator 裁决 Spec R7 留白处——
 * 确定性、单调、档内平滑；24/27/30 三档全过 → ×(1+0.2×3)=1.6）。
 */
export const UNLOCK_STEP_GAIN = 0.2;

/**
 * 线权重调度上下文：battle.lineScheduleEcho 的消费子集——growth-projection 只需要
 * lines 回显（openAt/unlockLevels，已由 clampLineSchedule 钳制）、derivedStageBounds
 * 切点（绝对等级 [earlyEnd, lateStart]）与 stageFocus 显式段 focus 映射
 * （Review P1-B：仅 stages 恰 3 段且切点未回退才存在），derivedKeyNodes 不参与权重计算。
 */
export type LineWeightSchedule = Pick<
  NonNullable<ComputedBattleData["lineScheduleEcho"]>,
  "lines" | "derivedStageBounds" | "stageFocus"
>;

/**
 * 线贡献爬坡权重 w(line, L)（Spec R7 / S9b，确定性纯函数；L = hero 主线等级）：
 *
 *   L < openAt              → 0                        （未开放零贡献）
 *   openAt ≤ L < openAt+RAMP → (L − openAt) / RAMP      （开放线性渐入）
 *   L ≥ openAt+RAMP         → 1
 *   × focusBoost  —— 仅当 stageFocus 存在（stages 恰 3 段且切点未回退）：L 所在段
 *                    （绝对等级 [1,e)/[e,s)/[s,∞)，e/s = derivedStageBounds）的
 *                    主 focus 线获 × FOCUS_BOOST_DEFAULT
 *   × unlockBoost —— unlockLevels 中已越过（L ≥ 档）的档数 k → × (1 + UNLOCK_STEP_GAIN × k)
 *
 * focusBoost 判定（Review 修复 P1-B）：消费 echo.stageFocus 显式映射（resolveStageFocus
 * 产物），废弃旧「openAt == 段起点」巧合等价——切点回退缺省（[⌈0.2L⌉, ⌈0.7L⌉]）后
 * 该判定会让未声明线意外获 boost（缺省 openAt 1 与首段起点 1 重合、openAt 恰与缺省
 * 切点重合），与 FOCUS_BOOST_DEFAULT docstring「无 stages 声明时无 focus 放大」矛盾。
 * 边界：focusLines[1..] 副焦点线不获 boost；stageFocus 缺失 → 无任何 focus 放大。
 *
 * 未声明 openAt 的线 = openAt 1（与 hero 同起点爬坡）；schedule 缺失 → 恒 1
 * （缺省恒等 S1：不改变现行为，×1.0 为 IEEE 精确操作）。
 */
export function lineWeight(
  lineId: string,
  heroLevel: number,
  schedule: LineWeightSchedule | undefined
): number {
  if (!schedule) return 1;
  const entry = schedule.lines[lineId];
  const openAt = entry?.openAt ?? 1; // 未声明 openAt 的线 = openAt 1
  if (heroLevel < openAt) return 0;
  let w =
    heroLevel >= openAt + RAMP_LEVELS ? 1 : (heroLevel - openAt) / RAMP_LEVELS;
  // focusBoost：stageFocus 显式段映射（Review P1-B，见 docstring）
  if (schedule.stageFocus) {
    const [earlyEnd, lateStart] = schedule.derivedStageBounds;
    const seg: "early" | "mid" | "late" =
      heroLevel >= lateStart ? "late" : heroLevel >= earlyEnd ? "mid" : "early";
    if (schedule.stageFocus[seg] === lineId) w *= FOCUS_BOOST_DEFAULT;
  }
  // unlockBoost：已越过档数 k → ×(1 + UNLOCK_STEP_GAIN × k)（档内平滑 = 台阶阶跃）
  if (entry?.unlockLevels && entry.unlockLevels.length > 0) {
    const passed = entry.unlockLevels.filter((u) => heroLevel >= u).length;
    w *= 1 + UNLOCK_STEP_GAIN * passed;
  }
  return w;
}

/** 四维基础属性列（其余 attributeCategories 类目视为 special 聚合槽展开目标） */
const CORE_ATTRIBUTE_IDS = new Set(["attack", "defense", "hp", "speed"]);

/** 特殊类目标识（未在四维清单中的类目） */
const isSpecialCategory = (id: string): boolean => !CORE_ATTRIBUTE_IDS.has(id);

/** log-progress 进度（0→1）：day=1 精确为 0，day=180 精确为 1 */
function logProgress(day: number, shapeFactor: number): number {
  return Math.min(1, Math.pow(Math.log(day) / Math.log(HORIZON_DAY), shapeFactor));
}

// ==================== 线进度模型（含离散档位连续化插值，原始口径保留） ====================

type GrowthLine = ComputedBattleData["growthLines"][number];

interface LineStage {
  progress: number;
  stage: string;
}

/** hero：等级进度 = maxLevel × (1 - e^(-k·day)) 渐近曲线（输出口径=等级） */
function heroStage(day: number, pace: ProjectionPace, maxLevel: number): LineStage {
  // heroRatio 单源（Review Coherence #5 收口：渐近式仅此一处，与 R7 权重 L 口径同式）
  const level = maxLevel * heroRatio(day, pace);
  return { progress: level, stage: `Lv.${Math.round(level)}` };
}

/**
 * equipment：品质档位 1→maxQuality 连续插值（log-progress 形状），
 * 小数段（外包 ROUNDDOWN+MOD 方法论）映射为档内强化等级（输出口径=品质）。
 */
function equipmentStage(day: number, pace: ProjectionPace, maxQuality: number): LineStage {
  const quality = 1 + (maxQuality - 1) * logProgress(day, SHAPE_FACTOR[pace]);
  const enhance = Math.round((quality - Math.floor(quality)) * MAX_ENHANCE_PER_TIER);
  return { progress: quality, stage: `品质 ${quality.toFixed(1)} + 强化 +${enhance}` };
}

/** skill/pet：深度完成度 0→1（输出口径=0-1 ratio），映射档位等级（skill upgrade-star 附升星进度） */
function skillStage(day: number, pace: ProjectionPace, skillDepth: string): LineStage {
  const ratio = logProgress(day, SHAPE_FACTOR[pace]);
  const level = Math.max(1, Math.round(DEPTH_MAX_LEVEL * ratio));
  const star = skillDepth === "upgrade-star" ? ` + ${Math.floor(ratio * DEPTH_MAX_STARS)}星` : "";
  return { progress: ratio, stage: `技能 Lv.${level}${star}` };
}

function petStage(day: number, pace: ProjectionPace): LineStage {
  const ratio = logProgress(day, SHAPE_FACTOR[pace]);
  const level = Math.max(1, Math.round(DEPTH_MAX_LEVEL * ratio));
  return { progress: ratio, stage: `宠物 Lv.${level}` };
}

/** hero 渐近进度率（lineRatio hero 分支单源；R7 heroLevel 的 L 口径共用同式） */
function heroRatio(day: number, pace: ProjectionPace): number {
  return Math.min(1, 1 - Math.exp(-HERO_K[pace] * day));
}

/**
 * 线进度率 r_line(day) ∈ [0,1]（内部量）：hero = 等级/上限（渐近，day=180 ≈0.989 故意
 * 不满级）；equipment = (品质−1)/(上限−1)；skill/pet = 深度 ratio。
 */
function lineRatio(line: GrowthLine, day: number, pace: ProjectionPace): number {
  if (line.type === "hero") return heroRatio(day, pace);
  return logProgress(day, SHAPE_FACTOR[pace]);
}

// ==================== 供给模型构建 ====================

/** 属性供给锚点（growthTable 首末行，键经 normalizeAttrKey 归一） */
interface LevelAnchors {
  level1: Map<string, number>;
  levelMax: Map<string, number>;
}

function buildLevelAnchors(table: Array<Record<string, unknown>>): LevelAnchors {
  // 防护：computePowerAtDay 经 index.ts 公开导出，外部直调可能传入缺失/空表
  // （引擎内部路径 battle/growth-projection 恒由引擎生成非空表，不受影响）——
  // code-review P3：裸 TypeError 换成与结构字段缺失同语义的中文降级错误
  if (!Array.isArray(table) || table.length === 0) {
    throw new Error(
      "battle 数据缺少属性成长表（attributeGrowthTable），无法计算战力；请在战斗规划模块重新生成方案"
    );
  }
  const first = table[0];
  const last = table[table.length - 1];
  const level1 = new Map<string, number>();
  const levelMax = new Map<string, number>();
  const read = (row: Record<string, unknown>, key: string): number => {
    const raw = Number(row[key]);
    return Number.isFinite(raw) ? raw : 0;
  };
  const keys = new Set([...Object.keys(first), ...Object.keys(last)]);
  for (const key of keys) {
    if (key === "level") continue;
    const norm = normalizeAttrKey(key);
    level1.set(norm, read(first, key));
    levelMax.set(norm, read(last, key));
  }
  return { level1, levelMax };
}

/**
 * 列份额 colShare(line, c) = weightPct(line, c) / Σ_l weightPct(l, c)（行归一上游给出，列归一现算）。
 * special 聚合槽均分到全部特殊类目（extended-6 各半 / special-flow 各三分之一）；
 * 无特殊类目时并入防御（与上游 classic-4 并列规则一致）。
 * 行缺失/空的线不产出条目（r_line 不参与 weightedProgress，线 power=0）。
 */
function buildColShares(
  battle: GrowthProjectionBattle
): Map<string, Map<string, number>> {
  const specialCategories = battle.attributeCategories
    .map((c) => c.id)
    .filter(isSpecialCategory);
  const colTotals = new Map<string, number>();
  const rawByLine = new Map<string, Map<string, number>>();
  for (const row of battle.allocationMatrix) {
    if (!row || row.allocations.length === 0) continue;
    const raw = new Map<string, number>();
    for (const allocation of row.allocations) {
      if (allocation.weightPct <= 0) continue;
      const targets =
        allocation.attributeId === "special" && specialCategories.length > 0
          ? specialCategories
          : [allocation.attributeId];
      for (const target of targets) {
        const key = normalizeAttrKey(target);
        const weight = allocation.weightPct / targets.length;
        raw.set(key, (raw.get(key) ?? 0) + weight);
        colTotals.set(key, (colTotals.get(key) ?? 0) + weight);
      }
    }
    rawByLine.set(row.growthLineId, raw);
  }
  const shares = new Map<string, Map<string, number>>();
  for (const [lineId, raw] of rawByLine) {
    const normalized = new Map<string, number>();
    for (const [key, weight] of raw) {
      const total = colTotals.get(key) ?? 0;
      if (total > 0) normalized.set(key, weight / total);
    }
    shares.set(lineId, normalized);
  }
  return shares;
}

/** 公式类型解析：damageFormulaFramework 文本匹配 > 引擎兜底 multiplicative（默认系数链口径） */
function resolveFormulaType(
  framework: ComputedBattleData["damageFormulaFramework"] | undefined
): PowerFormulaType {
  const text = `${framework?.description ?? ""} ${framework?.baseFormula ?? ""}`;
  for (const t of ["reduction", "multiplicative", "hybrid"] as const) {
    if (text.includes(t)) return t;
  }
  return "multiplicative";
}

/** 战力公式参数：公式框架/技能加权来自可选键，标准锚来自 growthTable 末行 */
function resolvePowerParams(
  battle: GrowthProjectionBattle,
  levelMax: Map<string, number>
): PowerFormulaParams {
  return {
    formulaType: resolveFormulaType(battle.damageFormulaFramework),
    coefficients: battle.damageFormulaFramework?.coefficients ?? {},
    skillMultiplier: weightedSkillMultiplier(battle.skillFramework?.skillDetails),
    critDmgMult: 1.5,
    stdAtk: levelMax.get("attack") ?? 0,
    stdSpeed: levelMax.get("speed") ?? 0,
  };
}

// ==================== 同源供给计算（battle.powerProfile 共用单源） ====================

interface SupplyInputs {
  participating: Array<GrowthLine & { splittable: boolean }>;
  anchors: LevelAnchors;
  colShares: Map<string, Map<string, number>>;
  params: PowerFormulaParams;
  /** 线调度上下文（battle.lineScheduleEcho 子集；缺失 → 线权重恒 1 = 现行为） */
  schedule: LineWeightSchedule | undefined;
}

function buildSupplyInputs(battle: GrowthProjectionBattle): SupplyInputs {
  const switches = battle.systemSwitches;
  // 按 systemSwitches 过滤参与线（防御：与上游条件展开双保险）
  const participating = battle.growthLines
    .filter((line) => {
      if (line.type === "skill") return switches.skillDepth !== "none";
      if (line.type === "pet") return switches.petEnabled !== false;
      return true;
    })
    .map((line) => {
      const row = battle.allocationMatrix.find((r) => r.growthLineId === line.id);
      return { ...line, splittable: (row?.allocations.length ?? 0) > 0 };
    });
  const anchors = buildLevelAnchors(battle.attributeGrowthTable);
  return {
    participating,
    anchors,
    colShares: buildColShares(battle),
    params: resolvePowerParams(battle, anchors.levelMax),
    schedule: battle.lineScheduleEcho,
  };
}

/**
 * day → 线权重快照（R7 注入形态）：day 循环内一次构建，属性供给（attrsAt）与线贡献
 * （rawPowers）两处消费同一 Map 保持口径一致。L 口径 = hero 主线等级：
 * heroLevel(day) = clamp(⌈r_hero(day) × heroMaxLevel⌉, 1, heroMaxLevel)
 * （r_hero 沿用现有 hero 渐近曲线 heroRatio）。
 * 无调度（lineScheduleEcho 缺失）→ 全部 1 = 现行为（byte 级恒等，S1）。
 */
function buildDayWeights(
  participating: SupplyInputs["participating"],
  schedule: LineWeightSchedule | undefined,
  day: number,
  pace: ProjectionPace,
  heroMaxLevel: number
): Map<string, number> {
  if (!schedule) {
    return new Map(participating.map((l) => [l.id, 1] as [string, number]));
  }
  const heroLevel = Math.min(
    heroMaxLevel,
    Math.max(1, Math.ceil(heroRatio(day, pace) * heroMaxLevel))
  );
  return new Map(
    participating.map((l) => [l.id, lineWeight(l.id, heroLevel, schedule)] as [string, number])
  );
}

/**
 * 指定 day 的属性供给：`level_1[c] + (level_max[c] − level_1[c]) × weightedProgress(c, day)`。
 * 某属性列全 0（无任何线投放）→ 恒为 level_1[c]（无成长来源，不凭空成长）。
 */
function attrsAt(
  inputs: SupplyInputs,
  day: number,
  pace: ProjectionPace,
  weights: Map<string, number>
): Record<string, number> {
  const attrs: Record<string, number> = {};
  const weighted = new Map<string, number>();
  for (const line of inputs.participating) {
    if (!line.splittable) continue;
    const shares = inputs.colShares.get(line.id);
    if (!shares || shares.size === 0) continue;
    const r = lineRatio(line, day, pace);
    // R7 线贡献爬坡：share × r × w（无调度 w 恒 1，×1.0 为 IEEE 精确操作 = 现行为）
    const w = weights.get(line.id) ?? 1;
    for (const [key, share] of shares) {
      weighted.set(key, (weighted.get(key) ?? 0) + share * r * w);
    }
  }
  for (const [key, lv1] of inputs.anchors.level1) {
    const lvMax = inputs.anchors.levelMax.get(key) ?? lv1;
    // Review 修复（P1-C 供给上界）：按列权重Σ clamp ≤1——成长表满级锚 = 设计真源
    //（damageSimulations「生存验证 Lv.L」消费同表），focus/unlock 权重的语义是加速
    // 触达设计上限，不是突破设计（曾实测 hp 超 lvMax 57.8%）；无调度时 Σ≤1 恒成立，
    // min(1,·) 为无操作，缺省恒等保持
    attrs[key] = lv1 + (lvMax - lv1) * Math.min(1, weighted.get(key) ?? 0);
  }
  return attrs;
}

/**
 * W0 同源单源：从 battle 数据计算指定 day 的属性供给与战力。
 * battle.ts 的 powerProfile（day=HORIZON_DAY）与投影锚点共用本函数，
 * 保证 `powerProfile.power = 投影末锚 totalPower`（同源构造性成立，防两套口径漂移）。
 */
export function computePowerAtDay(
  battle: GrowthProjectionBattle,
  day: number,
  options?: Pick<ProjectionOptions, "pace" | "heroMaxLevel">
): { attrs: Record<string, number>; params: PowerFormulaParams; stats: PowerStats } {
  const inputs = buildSupplyInputs(battle);
  const pace = options?.pace ?? "standard";
  // heroMaxLevel 同时是 R7 权重 L 口径的等级上限（battle 产物带 lineScheduleEcho 时
  // 生效；缺省 = 产物自描述 growthTable 末行 level，与 heroStage 展示口径一致——
  // V8 W3-T3 两消费位同源，battle.ts powerProfile 消费同解析）
  const heroMaxLevel = options?.heroMaxLevel ?? resolveHeroMaxLevel(battle);
  const weights = buildDayWeights(inputs.participating, inputs.schedule, day, pace, heroMaxLevel);
  const attrs = attrsAt(inputs, day, pace, weights);
  return { attrs, params: inputs.params, stats: computePowerStats(attrs, inputs.params) };
}

// ==================== 主函数 ====================

export function computeGrowthProjection(
  battle: GrowthProjectionBattle,
  options?: ProjectionOptions
): ComputedGrowthProjection {
  // 结构字段 + attributeGrowthTable 存在性校验（S8 存量兼容）：缺失 → 抛错交由
  // 面板层 try-catch 降级为 null（不静默产出空推演，防止误导）
  const requiredFields = [
    "systemSwitches",
    "growthLines",
    "attributeCategories",
    "allocationMatrix",
    "attributeGrowthTable",
  ] as const;
  const missingFields = requiredFields.filter(
    (key) => battle[key] === undefined || battle[key] === null
  );
  if (missingFields.length > 0) {
    throw new Error(
      `battle 数据缺少结构层字段（${missingFields.join("、")}），无法推演成长投影；` +
        `旧版方案请在战斗规划模块重新生成以补全结构层`
    );
  }
  if (battle.attributeGrowthTable.length === 0) {
    throw new Error(
      `battle 数据的 attributeGrowthTable 为空表，无法推演成长投影；` +
        `旧版方案请在战斗规划模块重新生成以补全属性成长表`
    );
  }

  const pace: ProjectionPace = options?.pace ?? "standard";
  // 缺省产物自描述（V8 W3-T3，与 computePowerAtDay 同源）：growthTable 末行 level，
  // 无自描述回退 60——battle 产物 maxLevel≠60 时 hero 轴（stage 展示 + R7 权重 L）与产物对齐
  const heroMaxLevel = options?.heroMaxLevel ?? resolveHeroMaxLevel(battle);
  const equipmentMaxQuality = options?.equipmentMaxQuality ?? DEFAULT_EQUIPMENT_MAX_QUALITY;
  // 边界条件：锚点 day 必须 ≥1，非法锚点过滤（不抛错）
  const days = (options?.anchors ?? DEFAULT_ANCHORS).filter((day) => day >= 1);

  const inputs = buildSupplyInputs(battle);
  const switches = battle.systemSwitches;

  const anchors = days.map((day) => {
    // 0. 线权重快照（R7 线贡献爬坡）：属性供给与线贡献共用，保持口径一致
    const weights = buildDayWeights(
      inputs.participating,
      inputs.schedule,
      day,
      pace,
      heroMaxLevel
    );

    // 1. 线进度（原始口径输出）与进度率（内部量）
    const lineStates = inputs.participating.map((line) => {
      let stage: string;
      let progress: number;
      switch (line.type) {
        case "hero":
          ({ progress, stage } = heroStage(day, pace, heroMaxLevel));
          break;
        case "equipment":
          ({ progress, stage } = equipmentStage(day, pace, equipmentMaxQuality));
          break;
        case "skill":
          ({ progress, stage } = skillStage(day, pace, switches.skillDepth));
          break;
        default:
          ({ progress, stage } = petStage(day, pace));
          break;
      }
      return {
        line,
        progress,
        stage: line.splittable ? stage : `${stage}（未切分）`,
        r: line.splittable ? lineRatio(line, day, pace) : 0,
      };
    });

    // 2. 属性供给 → 战力（同源单源链）
    const attrs = attrsAt(inputs, day, pace, weights);
    const stats = computePowerStats(attrs, inputs.params);

    // 3. 线贡献（一阶近似）：Σ_c Δc × colShare(line,c) × r_line × w_line × marginal_c，
    //    后按比例归一到 Σlines = totalPower（构造性归一约定，非线性边际的一阶近似再重归一）
    const rawPowers = lineStates.map((state) => {
      if (!state.line.splittable) return 0;
      const shares = inputs.colShares.get(state.line.id);
      if (!shares || shares.size === 0) return 0;
      const w = weights.get(state.line.id) ?? 1; // R7：与属性供给同一 w，口径一致
      let raw = 0;
      for (const [key, share] of shares) {
        const lv1 = inputs.anchors.level1.get(key) ?? 0;
        const lvMax = inputs.anchors.levelMax.get(key) ?? lv1;
        const marginal = stats.attrMarginalValues[key] ?? 0;
        raw += (lvMax - lv1) * share * state.r * w * marginal;
      }
      return raw;
    });
    const rawSum = rawPowers.reduce((s, v) => s + v, 0);

    const lines = lineStates.map((state, i) => ({
      id: state.line.id,
      name: state.line.name,
      type: state.line.type,
      progress: state.progress,
      stage: state.stage,
      power: rawSum > 0 ? (rawPowers[i] / rawSum) * stats.power : 0,
    }));

    // 4. attributes：全部类目输出（列全 0 → 恒 level_1）；
    //    sharePct = 战力价值占比（value × marginal 归一，Spec W0 语义升级）
    const valueMarginal: Array<{ id: string; name: string; value: number; weighted: number }> = [];
    let weightedSum = 0;
    for (const category of battle.attributeCategories) {
      const value = attrs[category.id] ?? 0;
      const weighted = value * (stats.attrMarginalValues[category.id] ?? 0);
      weightedSum += weighted;
      valueMarginal.push({ id: category.id, name: category.name, value, weighted });
    }
    const attributes = valueMarginal.map((item) => ({
      id: item.id,
      name: item.name,
      value: item.value,
      sharePct: weightedSum > 0 ? (item.weighted / weightedSum) * 100 : 0,
    }));

    return { day, totalPower: stats.power, lines, attributes };
  });

  return {
    moduleType: "growth-projection",
    anchors,
    pace,
  };
}
