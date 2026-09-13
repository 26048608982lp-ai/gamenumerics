import { interpolateFromAnchors, computeAttributeValue } from "./curves";
import type { BattleDesignIntent, StageAllocation } from "./types";
import type { ComputedBattleData } from "@/lib/types/planning";
import { computePowerAtDay, HORIZON_DAY } from "./growth-projection";
import {
  STAGE_BOUNDS_DEFAULT,
  deriveKeyNodes,
  deriveStageBounds,
  resolveStageFocus,
  stageBoundsToLevels,
  clampLineSchedule,
} from "./stages";

// ==================== 结构层派生（迁移自已移除的原战斗框架模块，T2b 结构下沉）====================
// 纯函数：按 structuralDecisions 结构决策确定性派生成长线×属性投放矩阵，
// 相同输入产出相同矩阵（无 LLM、无随机、无外部依赖）。
// 数值来源 = 原战斗框架 Spec（历史归档文档）附录 A.3 精确规则表（9 行成长线×精确 weightPct，Σ=100 每线）。

/** battle 输出中的结构块（ComputedBattleData 的 4 结构字段） */
type StructuralBlock = Pick<
  ComputedBattleData,
  "systemSwitches" | "growthLines" | "attributeCategories" | "allocationMatrix"
>;

/** 战斗结构决策（intent.structuralDecisions 的形状，原框架层 decisions 下沉） */
type BattleStructuralDecisions = NonNullable<BattleDesignIntent["structuralDecisions"]>;

export type MatrixColumn = "attack" | "defense" | "hp" | "speed" | "special";

type GrowthLineDef = ComputedBattleData["growthLines"][number];

/**
 * 默认结构决策（LLM 无问卷路径的合法缺省，S8 存量兼容）：
 * intent.structuralDecisions 缺失时按此常量计算，保证输出形状恒定
 * （4 结构字段永远存在，下游 GrowthProjectionPanel / cross-validator 无需判空崩溃）。
 * 取值 = 问卷 A.1 默认组合（五人阵容/回合制/升星/装备 4 类/无宠物/技能可升级/四维/不设特殊线）。
 */
export const DEFAULT_STRUCTURAL_DECISIONS: BattleStructuralDecisions = {
  formationSize: 5,
  battlePace: "turn-based",
  heroStarEnabled: true,
  equipmentEnabled: true,
  equipmentCategories: 4,
  petEnabled: false,
  skillDepth: "upgrade",
  attributeScheme: "classic-4",
  specialAttrFocus: "none",
};

/** 属性类目方案 → 精确类目清单（classic-4 四项 / extended-6 六项 / special-flow 七项） */
const ATTRIBUTE_SCHEMES: Record<
  BattleStructuralDecisions["attributeScheme"],
  Array<{ id: string; name: string }>
> = {
  "classic-4": [
    { id: "attack", name: "攻击" },
    { id: "defense", name: "防御" },
    { id: "hp", name: "生命" },
    { id: "speed", name: "速度" },
  ],
  "extended-6": [
    { id: "attack", name: "攻击" },
    { id: "defense", name: "防御" },
    { id: "hp", name: "生命" },
    { id: "speed", name: "速度" },
    { id: "crit", name: "暴击" },
    { id: "effect-hit", name: "效果命中" },
  ],
  "special-flow": [
    { id: "attack", name: "攻击" },
    { id: "defense", name: "防御" },
    { id: "hp", name: "生命" },
    { id: "speed", name: "速度" },
    { id: "element-attack", name: "元素攻击" },
    { id: "penetration", name: "穿透" },
    { id: "special-resist", name: "特殊抗性" },
  ],
};

/** 矩阵列定义：id 对齐引擎 allocations 的 attributeId，label 为展示列头 */
export interface MatrixColumnDef {
  id: "attack" | "defense" | "hp" | "speed" | "special";
  label: string;
}

/** 四维核心属性 id（special 聚合槽之外的固定列，与 ATTRIBUTE_SCHEMES 各方案前四项一致） */
const FOUR_CORE_IDS = ["attack", "defense", "hp", "speed"] as const;

/** 四维列头兜底名（attributeCategories 未含对应类目时兜底） */
const FOUR_CORE_FALLBACK_NAMES: Record<string, string> = {
  attack: "攻击",
  defense: "防御",
  hp: "生命",
  speed: "速度",
};

/**
 * attributeCategories → 矩阵列定义（展示组件共用口径，对齐引擎 allocationMatrix）：
 * 引擎 allocations 的 attributeId 只有四维 + "special" 聚合槽（extended-6/special-flow
 * 下 special 承载全部特殊类目份额），故列 = 四维固定列 + special 聚合列，
 * special 列头 = 特殊类目名拼接（如"暴击/效果命中"）；
 * classic-4 无特殊类目 → 无 special 列，矩阵退化为 4 列。
 */
export function buildMatrixColumns(
  attributeCategories: Array<{ id: string; name: string }>
): MatrixColumnDef[] {
  const specialCategories = attributeCategories.filter(
    (c) => !(FOUR_CORE_IDS as readonly string[]).includes(c.id),
  );
  const coreColumns: MatrixColumnDef[] = FOUR_CORE_IDS.map((id) => ({
    id,
    label:
      attributeCategories.find((c) => c.id === id)?.name ||
      FOUR_CORE_FALLBACK_NAMES[id] ||
      id,
  }));
  if (specialCategories.length === 0) return coreColumns;
  return [
    ...coreColumns,
    {
      id: "special",
      label: specialCategories.map((c) => c.name).join("/") || "特殊",
    },
  ];
}

/**
 * A.3 矩阵精确规则表：成长线 → 各属性 weightPct（Σ=100）。
 * "special" 为聚合槽（extended-6/special-flow 下承载特殊类目份额；
 * classic-4 无特殊类目时并入防御，宠物线并入生命）。
 */
const LINE_ALLOCATION_RULES: Record<string, Partial<Record<MatrixColumn, number>>> = {
  hero: { attack: 40, hp: 35, defense: 15, speed: 10 },
  "equipment-weapon": { attack: 65, speed: 20, hp: 15 },
  "equipment-armor": { defense: 55, hp: 45 },
  "equipment-helm": { hp: 55, defense: 45 },
  "equipment-accessory": { speed: 40, special: 40, attack: 20 },
  "equipment-charm": { special: 55, speed: 25, hp: 20 },
  "equipment-boots": { speed: 50, defense: 30, hp: 20 },
  skill: { attack: 50, special: 30, hp: 20 },
  pet: { special: 60, hp: 25, defense: 15 },
};

/** 装备分类数 → 装备成长线（非 2/4/6 值按默认档 4 处理） */
const EQUIPMENT_LINE_DEFS: Record<number, GrowthLineDef[]> = {
  2: [
    { id: "equipment-weapon", name: "武器", type: "equipment" },
    { id: "equipment-armor", name: "护甲", type: "equipment" },
  ],
  4: [
    { id: "equipment-weapon", name: "武器", type: "equipment" },
    { id: "equipment-armor", name: "护甲", type: "equipment" },
    { id: "equipment-helm", name: "头盔", type: "equipment" },
    { id: "equipment-accessory", name: "饰品", type: "equipment" },
  ],
  6: [
    { id: "equipment-weapon", name: "武器", type: "equipment" },
    { id: "equipment-armor", name: "护甲", type: "equipment" },
    { id: "equipment-helm", name: "头盔", type: "equipment" },
    { id: "equipment-accessory", name: "饰品", type: "equipment" },
    { id: "equipment-charm", name: "护符", type: "equipment" },
    { id: "equipment-boots", name: "战靴", type: "equipment" },
  ],
};

/**
 * specialAttrFocus 矛盾组合确定性 fallback（原战斗框架 Spec 历史边界条件）：
 * 指向未开启的成长线、或属性集无特殊类目（classic-4）→ 视为 none。
 * systemSwitches 回显有效值（下游注入链不消费矛盾状态）。
 *
 * Re.E1-5 导出为判定单源：UI（MatrixTool）消费 computed.focusOverride 元数据展示
 * 矛盾提示，判定与引擎同源（禁止 UI 复刻判定逻辑）。
 */
export function resolveEffectiveFocus(
  decisions: BattleStructuralDecisions
): BattleStructuralDecisions["specialAttrFocus"] {
  if (decisions.attributeScheme === "classic-4") return "none";
  if (decisions.specialAttrFocus === "equipment" && !decisions.equipmentEnabled) return "none";
  if (decisions.specialAttrFocus === "skill" && decisions.skillDepth === "none") return "none";
  if (decisions.specialAttrFocus === "pet" && !decisions.petEnabled) return "none";
  return decisions.specialAttrFocus;
}

/**
 * 矛盾组合 → focusOverride 变更元数据（Re.E1-5）：resolveEffectiveFocus 发生静默
 * 丢弃（from ≠ to）时产出 { from, to: "none", reason }，由 computed 顶层携带供
 * UI 非阻断提示；无丢弃返回 undefined（computed 不写键）。reason 分支顺序与
 * resolveEffectiveFocus 判定顺序一致（classic-4 优先于具体投放线）。
 */
export function buildFocusOverride(
  decisions: BattleStructuralDecisions
): ComputedBattleData["focusOverride"] {
  const from = decisions.specialAttrFocus;
  const to = resolveEffectiveFocus(decisions);
  if (to === from) return undefined;
  let reason: string;
  if (decisions.attributeScheme === "classic-4") {
    reason = "属性方案为 classic-4（无特殊类目），特殊投放线无承载类目";
  } else if (from === "equipment") {
    reason = "特殊投放线指向装备，但装备系统未开启";
  } else if (from === "skill") {
    reason = "特殊投放线指向技能，但技能深度为 none";
  } else {
    reason = "特殊投放线指向宠物，但宠物系统未开启";
  }
  return { from, to: "none", reason };
}

/** 按 structuralDecisions 条件展开成长线清单（hero 恒有；装备/技能/宠物按开关） */
function buildGrowthLines(decisions: BattleStructuralDecisions): GrowthLineDef[] {
  const lines: GrowthLineDef[] = [
    {
      id: "hero",
      // heroStarEnabled 只影响 name 描述，不改数值分配（升星是放大器，第一版不单独开线）
      name: decisions.heroStarEnabled ? "英雄本体（含升星）" : "英雄本体",
      type: "hero",
    },
  ];
  if (decisions.equipmentEnabled) {
    lines.push(...(EQUIPMENT_LINE_DEFS[decisions.equipmentCategories] ?? EQUIPMENT_LINE_DEFS[4]));
  }
  if (decisions.skillDepth !== "none") {
    lines.push({
      id: "skill",
      name: decisions.skillDepth === "upgrade-star" ? "技能（升级+升星）" : "技能",
      type: "skill",
    });
  }
  if (decisions.petEnabled) {
    lines.push({ id: "pet", name: "宠物", type: "pet" });
  }
  return lines;
}

type Allocation = ComputedBattleData["allocationMatrix"][number]["allocations"][number];

/** 行内 role 标注：最大占比为 primary（并列取列序靠前者），其余非零为 secondary，零为 none */
function assignRowRoles(allocations: Allocation[]): void {
  let maxIndex = -1;
  for (let i = 0; i < allocations.length; i++) {
    const w = allocations[i].weightPct;
    if (w > 0 && (maxIndex === -1 || w > allocations[maxIndex].weightPct)) {
      maxIndex = i;
    }
  }
  allocations.forEach((a, i) => {
    a.role = a.weightPct === 0 ? "none" : i === maxIndex ? "primary" : "secondary";
  });
}

/**
 * specialAttrFocus 的 role 侧重覆盖（矩阵数值不变）：
 * focus 指定类型线的 special 单元格升 primary（同行原 primary 降 secondary）；
 * 非 focus 线的 special 降 secondary（行内剩余最大升 primary）。
 */
function applyFocusRole(
  result: Pick<StructuralBlock, "growthLines" | "allocationMatrix">,
  effectiveFocus: BattleStructuralDecisions["specialAttrFocus"]
): void {
  if (effectiveFocus === "none") return;
  const lineTypes = new Map(result.growthLines.map((l) => [l.id, l.type]));
  for (const row of result.allocationMatrix) {
    const special = row.allocations.find((a) => a.attributeId === "special");
    if (!special || special.weightPct === 0) continue; // 无 special 列或无份额
    if (lineTypes.get(row.growthLineId) === effectiveFocus) {
      special.role = "primary";
      for (const a of row.allocations) {
        if (a !== special && a.role === "primary") a.role = "secondary";
      }
    } else {
      special.role = "secondary";
      if (!row.allocations.some((a) => a.role === "primary")) {
        let maxIndex = -1;
        for (let i = 0; i < row.allocations.length; i++) {
          const a = row.allocations[i];
          if (
            a !== special &&
            a.weightPct > 0 &&
            (maxIndex === -1 || a.weightPct > row.allocations[maxIndex].weightPct)
          ) {
            maxIndex = i;
          }
        }
        if (maxIndex >= 0) row.allocations[maxIndex].role = "primary";
      }
    }
  }
}

/** 单条成长线的属性份额展开（classic-4 时特殊份额并入防御，宠物线并入生命） */
function buildAllocations(
  lineId: string,
  hasSpecialColumn: boolean
): Allocation[] {
  const rule = LINE_ALLOCATION_RULES[lineId] ?? {};
  const weights: Record<MatrixColumn, number> = {
    attack: 0,
    defense: 0,
    hp: 0,
    speed: 0,
    special: 0,
  };
  for (const col of Object.keys(weights) as MatrixColumn[]) {
    weights[col] = rule[col] ?? 0;
  }
  if (!hasSpecialColumn && weights.special > 0) {
    if (lineId === "pet") {
      weights.hp += weights.special; // 宠物线特殊份额并入生命
    } else {
      weights.defense += weights.special; // 其余成长线并入防御
    }
    weights.special = 0;
  }
  const columns: MatrixColumn[] = hasSpecialColumn
    ? ["attack", "defense", "hp", "speed", "special"]
    : ["attack", "defense", "hp", "speed"];
  const allocations = columns.map((col) => ({
    attributeId: col,
    role: "none" as const,
    weightPct: weights[col],
  }));
  assignRowRoles(allocations);
  return allocations;
}

/** 结构决策 → 4 结构字段（systemSwitches / growthLines / attributeCategories / allocationMatrix） */
function computeStructuralBlock(decisions: BattleStructuralDecisions): StructuralBlock {
  const effectiveFocus = resolveEffectiveFocus(decisions);
  // classic-4 无特殊类目 → 矩阵退化为 4 列；其余 scheme 恒定 5 列（四维+special 聚合槽）
  const hasSpecialColumn = decisions.attributeScheme !== "classic-4";

  const growthLines = buildGrowthLines(decisions);

  // systemSwitches 只回显 9 个开关字段——V8 W2 第 10/11 键（stageAllocation /
  // lineSchedule）是阶段化扩展，不进开关回显（输出形状与存量消费者契约不变）
  const switchesOnly = { ...decisions };
  delete switchesOnly.stageAllocation;
  delete switchesOnly.lineSchedule;

  const result: StructuralBlock = {
    systemSwitches: { ...switchesOnly, specialAttrFocus: effectiveFocus },
    growthLines: growthLines.map((l) => ({ ...l })),
    attributeCategories: ATTRIBUTE_SCHEMES[decisions.attributeScheme].map((c) => ({ ...c })),
    allocationMatrix: growthLines.map((l) => ({
      growthLineId: l.id,
      allocations: buildAllocations(l.id, hasSpecialColumn),
    })),
  };
  applyFocusRole(result, effectiveFocus);
  return result;
}

// ==================== V8 W2-T2 属性投放矩阵阶段化（层 1）====================

/**
 * biases 合法性判定：至少含 1 个偏置值且全部为有限数。
 * 空（无任何偏置值）或含非有限数 → 整键忽略 = 恒等（不写 stageMatrices，
 * 延续 tierDifferentiation 整档回退先例；W3 Zod 前置拒绝属后续波次）。
 */
function isBiasesValid(biases: StageAllocation["biases"]): boolean {
  const values = [
    ...Object.values(biases?.early ?? {}),
    ...Object.values(biases?.late ?? {}),
  ];
  if (values.length === 0) return false;
  return values.every((v) => typeof v === "number" && Number.isFinite(v));
}

/**
 * 阶段化矩阵推导（Spec R2，确定性纯函数）：对基线矩阵（= allocationMatrix 行，
 * 已按 attributeScheme 完成 special 并入/拆分）逐属性施加偏置乘数后归一化。
 *
 * 每阶段 s ∈ {early, mid, late}、每线每属性：
 *   raw[attr] = base[attr] × clamp(bias, 0.5, 2)   （bias 缺省 1 → mid 恒等基线）
 *   归一化 Σ=100：四舍五入，余数（100 − Σrounded）补最大项
 * 任意合法偏置必然产出合法矩阵（乘数→归一化结构上不可能破坏 Σ=100 契约）。
 *
 * 三段矩阵各自完整覆盖全部成长线；bounds 只决定「哪份矩阵在哪个等级区间生效」的
 * 解释性元数据（裁决 A2），非行切分。行内 role 按段内数值重标注（assignRowRoles），
 * specialAttrFocus 的 role 侧重覆盖不进三段矩阵（层 1 与 focus 元数据正交）。
 */
export function deriveStageMatrices(
  base: ComputedBattleData["allocationMatrix"],
  biases: StageAllocation["biases"],
  bounds: [number, number],
): NonNullable<ComputedBattleData["stageMatrices"]> {
  const buildSegment = (segBias: Partial<Record<MatrixColumn, number>> | undefined) =>
    base.map((row) => {
      const biased = row.allocations.map((cell) => {
        const b = segBias?.[cell.attributeId as MatrixColumn];
        // 偏置缺省 1（恒等）；越界 clamp [0.5, 2]（引擎侧防御）
        const bias = b === undefined ? 1 : Math.max(0.5, Math.min(2, b));
        return { attributeId: cell.attributeId, role: "none" as const, weightPct: cell.weightPct * bias };
      });
      const rawSum = biased.reduce((s, a) => s + a.weightPct, 0);
      const rounded = biased.map((a) => Math.round((a.weightPct / rawSum) * 100));
      const remainder = 100 - rounded.reduce((s, v) => s + v, 0);
      // 余数补最大项（并列取列序靠前者，与 assignRowRoles 口径一致）
      let maxIndex = 0;
      for (let i = 1; i < rounded.length; i++) {
        if (rounded[i] > rounded[maxIndex]) maxIndex = i;
      }
      rounded[maxIndex] += remainder;
      const allocations = biased.map((a, i) => ({ ...a, weightPct: rounded[i] }));
      assignRowRoles(allocations);
      return { growthLineId: row.growthLineId, allocations };
    });

  return {
    bounds,
    early: buildSegment(biases.early),
    mid: buildSegment(undefined),
    late: buildSegment(biases.late),
  };
}

interface AttributeGrowthRow {
  level: number;
  [attr: string]: number;
}

/**
 * 里程碑锚点合法性校验 + 通过（V8 W2-T3，畸形 → 返回 null = 整键忽略恒等，不抛异常）：
 * - 等级：整数、严格升序、居 (1, totalLevels) 开区间内（首尾锚由 level_1/level_max 承载）
 * - 值：全部为有限数
 * - 方向：每属性序列 [level_1, m₁…, level_max] 须与两端点同向单调
 *   （start < end → 非降；start > end → 非升；start = end → 恒值），段内反向即违例
 */
function resolveMilestoneAnchors(
  milestones: BattleDesignIntent["anchors"]["milestones"],
  totalLevels: number,
  level_1: Record<string, number>,
  level_max: Record<string, number>,
): BattleDesignIntent["anchors"]["milestones"] | null {
  if (!milestones || milestones.length === 0) return null;
  let prevLevel = 0;
  for (const m of milestones) {
    const lvl = m?.level;
    if (
      typeof lvl !== "number" ||
      !Number.isInteger(lvl) ||
      lvl <= 1 ||
      lvl >= totalLevels ||
      lvl <= prevLevel
    ) {
      return null;
    }
    prevLevel = lvl;
    for (const v of Object.values(m.values ?? {})) {
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
    }
  }
  // 方向校验：逐属性（只校验里程碑声明的属性；未知属性键无成长列，静默无效）
  const mentioned = new Set<string>();
  for (const m of milestones) {
    for (const key of Object.keys(m.values ?? {})) mentioned.add(key);
  }
  for (const attr of mentioned) {
    // Review 修复（Correctness P2-1）：未知属性键（不在 level_1/level_max，无成长列）
    // 静默无效——不参与方向校验（曾以 0/0 端点构造 [0, v, 0] 序列，v>0 即毒化整键
    // 返回 null，与本注释上方「静默无效」语义相反）；注入侧 allAttrs 循环本就不读未知键
    if (!(attr in level_1) && !(attr in level_max)) continue;
    const start = level_1[attr] ?? 0;
    const end = level_max[attr] ?? 0;
    const seq = [
      start,
      ...milestones
        .map((m) => m.values[attr])
        .filter((v): v is number => v !== undefined),
      end,
    ];
    const nonDecreasing = end >= start;
    for (let i = 1; i < seq.length; i++) {
      if (nonDecreasing ? seq[i] < seq[i - 1] : seq[i] > seq[i - 1]) return null;
    }
  }
  return milestones;
}

/**
 * 伤害模拟行（type alias 而非 interface：ComputedBattleData.damageSimulations 为
 * Array<Record<string, unknown>>，type alias 对象形状带隐式索引签名方可赋入）
 */
type DamageSimulationRow = {
  scenario: string;
  attackerLevel: number;
  defenderLevel: number;
  expectedDamage: number;
  damageVsHigherDef: number;
  dpsEstimate?: number;
  isCrit?: boolean;
  usesSkill?: boolean;
  defenderHP?: number;
  hitsToKill?: number;
};

/**
 * 计算结果类型 = lib/types 单源别名（Re.E1-1）：形状权威在 ComputedBattleData，
 * 此名仅为引擎内部/调用方可读性保留。
 */
type BattleComputeResult = ComputedBattleData;

/**
 * 伤害计算顶层纯函数（growth-followups-trio c1 自 computeBattleFromIntent 内嵌提取，
 * 零行为变化）：difficulty-mirror 等下游直接复用，消灭公式拷贝。
 *
 * 系数兜底链（引擎默认参数集）：atkCoeff→attackCoefficient→1.0；defCoeff→defenseCoefficient→0.5；
 * K→100；flatBonus→flat_bonus→0。
 */
export function calcDamage(
  atk: number,
  def: number,
  formulaType: BattleDesignIntent["strategy"]["damageFormula"]["type"],
  coefficients: Record<string, number>,
  skillMultiplier: number = 1.0
): number {
  const atkCoeff = coefficients.atkCoeff ?? coefficients.attackCoefficient ?? 1.0;
  const defCoeff = coefficients.defCoeff ?? coefficients.defenseCoefficient ?? 0.5;
  if (formulaType === "multiplicative") {
    const K = coefficients.K ?? 100;
    return Math.round(atk * atkCoeff * skillMultiplier * K / (def * defCoeff + K));
  } else if (formulaType === "reduction") {
    return Math.max(1, Math.round(atk * atkCoeff * skillMultiplier - def * defCoeff));
  } else {
    const flatBonus = coefficients.flatBonus ?? coefficients.flat_bonus ?? 0;
    const defReduction = Math.min(defCoeff, 0.99);
    return Math.max(1, Math.round((atk + flatBonus) * atkCoeff * skillMultiplier * (1 - defReduction)));
  }
}

/**
 * 从设计意图计算完整数值（原内嵌 calcDamage 的调用点，公式口径经顶层导出函数承载）
 */
export function computeBattleFromIntent(
  intent: BattleDesignIntent
): BattleComputeResult {
  const { strategy, anchors } = intent;
  const {
    attributeDesign,
    damageFormula,
    skillFramework,
    combatPacing,
    expectedCombatDuration,
  } = strategy;
  const { level_1, level_max, maxLevel, attributeBudgets } = anchors;

  const totalLevels = maxLevel || 50;
  const allAttrs = [...attributeDesign.primary, ...attributeDesign.secondary];
  const growthModels = attributeDesign.growthModels;

  // V8 W2-T3：里程碑锚点合法性校验（畸形 → null = 整键忽略恒等）
  const milestoneAnchors = resolveMilestoneAnchors(
    anchors.milestones,
    totalLevels,
    level_1,
    level_max
  );

  // 1. 生成属性成长表
  const attributeGrowthTable: AttributeGrowthRow[] = [];

  for (let lvl = 1; lvl <= totalLevels; lvl++) {
    const row: AttributeGrowthRow = { level: lvl };
    const levelRatio = totalLevels > 1 ? (lvl - 1) / (totalLevels - 1) : 0;

    for (const attr of allAttrs) {
      const startVal = level_1[attr] ?? 0;
      const endVal = level_max[attr] ?? 0;
      const growth = (growthModels[attr] as "linear" | "exponential" | "sigmoid") || "linear";

      if (lvl === 1) {
        row[attr] = startVal;
      } else if (lvl === totalLevels) {
        row[attr] = endVal;
      } else {
        // 使用锚点插值：锚点序 [level_1, m₁…, level_max]（milestones 合法时注入中段锚，
        // 复用 interpolateFromAnchors 原生多锚点分段能力；null 时与旧两锚行为 byte 级一致）
        const anchors_map: Record<number, number> = {
          0: startVal,
          [totalLevels - 1]: endVal,
        };
        if (milestoneAnchors) {
          for (const m of milestoneAnchors) {
            const v = m.values[attr];
            if (v !== undefined) anchors_map[m.level - 1] = v;
          }
        }
        const values = interpolateFromAnchors(anchors_map, growth, totalLevels);
        row[attr] = Math.round(values[lvl - 1]);
      }
    }

    attributeGrowthTable.push(row);
  }

  // 2. 伤害模拟 — 标准场景矩阵（公式口径由顶层 calcDamage 承载，c1 提取）
  const damageSimulations: DamageSimulationRow[] = [];
  const coeffs = damageFormula.coefficients;

  // V8 W2-T4a：4 档取样（裁决 A1 白名单，已批准行为变化）——单 midLevel 退役，
  // earlySample/midSample 与 STAGE_BOUNDS_DEFAULT 同源推导（⌈L×frac⌉）。
  // 取样集合 = [1, earlySample, midSample, L]（totalLevels < 4 时自然去重收敛：
  // 场景行按名唯一，等级由钳制恒落 [1, L]，无越界行）。
  const [earlyFrac, lateFrac] = STAGE_BOUNDS_DEFAULT;
  const earlySample = Math.min(totalLevels, Math.max(1, Math.ceil(totalLevels * earlyFrac)));
  const midSample = Math.min(totalLevels, Math.max(1, Math.ceil(totalLevels * lateFrac)));
  const hpAtkRatio = anchors.hpAtkRatio ?? 10;

  // 计算 skillDetails 平均倍率
  const skillDetails = skillFramework.skillDetails;
  const avgSkillMultiplier = skillDetails && skillDetails.length > 0
    ? skillDetails.reduce((sum, s) => sum + s.avgMultiplier, 0) / skillDetails.length
    : 1.5;

  // 8 场景名不变，档位分配（Spec R4）：早期体验 1v1（前档）/ 同级普攻 E（前期档基准）/
  // 同级技能系 M（中段档）/ 越级 = max(1, M−5) 攻 vs M 防 / 碾压 = min(L, M+5) /
  // 生存验证 L vs L（终局语义，满级档）
  const scenarios: Array<{
    name: string;
    atkLevel: number;
    defLevel: number;
    skillMultiplier: number;
    isCrit: boolean;
    usesSkill: boolean;
  }> = [
    { name: "同级普攻", atkLevel: earlySample, defLevel: earlySample, skillMultiplier: 1.0, isCrit: false, usesSkill: false },
    { name: "同级技能爆发", atkLevel: midSample, defLevel: midSample, skillMultiplier: 2.0, isCrit: false, usesSkill: true },
    { name: "同级技能循环", atkLevel: midSample, defLevel: midSample, skillMultiplier: avgSkillMultiplier, isCrit: false, usesSkill: true },
    { name: "同级暴击", atkLevel: midSample, defLevel: midSample, skillMultiplier: 1.5, isCrit: true, usesSkill: false },
    { name: "越级+5挑战", atkLevel: Math.max(1, midSample - 5), defLevel: midSample, skillMultiplier: 1.0, isCrit: false, usesSkill: false },
    { name: "碾压-5", atkLevel: Math.min(totalLevels, midSample + 5), defLevel: midSample, skillMultiplier: 1.0, isCrit: false, usesSkill: false },
    { name: "生存验证", atkLevel: totalLevels, defLevel: totalLevels, skillMultiplier: 1.0, isCrit: false, usesSkill: false },
    { name: "早期体验(Lv.1)", atkLevel: 1, defLevel: 1, skillMultiplier: 1.0, isCrit: false, usesSkill: false },
  ];

  for (const sc of scenarios) {
    const atkRow = attributeGrowthTable[sc.atkLevel - 1];
    const defRow = attributeGrowthTable[sc.defLevel - 1];
    if (!atkRow || !defRow) continue;

    const atk = atkRow.ATK || atkRow.atk || 100;
    const def = defRow.DEF || defRow.def || 50;
    const hp = (defRow.HP || defRow.hp || def * hpAtkRatio);

    const expectedDamage = calcDamage(atk, def, damageFormula.type, coeffs, sc.skillMultiplier);
    const damageVsHigherDef = calcDamage(atk, Math.round(def * 1.3), damageFormula.type, coeffs, sc.skillMultiplier);
    const hitsToKill = expectedDamage > 0 ? Math.ceil(hp / expectedDamage) : 0;

    // DPS = expectedDamage × attacksPerSecond (derived from SPD)
    // attacksPerSecond = clamp(SPD / baseSpd, 0.5, 4)
    // 无 SPD 时降级为 expectedDamage（向后兼容）
    const spd = atkRow.SPD ?? atkRow.spd;
    const baseSpd = level_1.SPD ?? level_1.spd ?? 10;
    const attacksPerSecond = spd !== undefined
      ? Math.min(4, Math.max(0.5, spd / baseSpd))
      : undefined;
    const dpsEstimate = attacksPerSecond !== undefined
      ? Math.round(expectedDamage * attacksPerSecond)
      : expectedDamage;

    damageSimulations.push({
      scenario: sc.name,
      attackerLevel: sc.atkLevel,
      defenderLevel: sc.defLevel,
      expectedDamage: Math.max(1, expectedDamage),
      damageVsHigherDef: Math.max(1, damageVsHigherDef),
      dpsEstimate,
      isCrit: sc.isCrit,
      usesSkill: sc.usesSkill,
      defenderHP: Math.round(hp),
      hitsToKill: expectedDamage > 0 ? Math.ceil(hp / expectedDamage) : 0,
    });
  }

  // 结构层（T2b 吸收）：structuralDecisions 存在 → 按问卷决策派生；
  // 缺失 → DEFAULT_STRUCTURAL_DECISIONS 默认结构决策计算（LLM 无问卷路径的合法缺省，S8 存量兼容），
  // 输出形状恒定（4 结构字段永远存在，GrowthProjectionPanel / cross-validator / BattlePlanDisplay 直接消费）
  const structuralDecisions =
    intent.structuralDecisions ?? DEFAULT_STRUCTURAL_DECISIONS;
  const structural = computeStructuralBlock(structuralDecisions);
  // Re.E1-5：矛盾组合静默丢弃的变更元数据（无丢弃不写键，保持输出形状最小）
  const focusOverride = buildFocusOverride(structuralDecisions);

  // V8 W2-T2（层 1）：属性投放矩阵阶段化——仅当 stageAllocation 声明且 biases 合法时
  // 写键（缺省恒等，S1）。段边界按裁决 A2：stages 恰 3 段 → deriveStageBounds 两切点；
  // 否则 stageBounds ?? STAGE_BOUNDS_DEFAULT 占比换算绝对等级
  const stageAllocation = intent.structuralDecisions?.stageAllocation;
  const lineSchedule = intent.structuralDecisions?.lineSchedule;
  const stageMatrices =
    stageAllocation && isBiasesValid(stageAllocation.biases)
      ? deriveStageMatrices(
          structural.allocationMatrix,
          stageAllocation.biases,
          stageAllocation.stages?.length === 3
            ? deriveStageBounds(stageAllocation.stages, lineSchedule, totalLevels)
            : stageBoundsToLevels(
                stageAllocation.stageBounds ?? STAGE_BOUNDS_DEFAULT,
                totalLevels,
              ),
        )
      : undefined;

  // V8 W2-T6a（层 2）：养成线调度回显——仅当 lineSchedule 声明时写键（缺省恒等，S1）
  // Review 修复（P1-B）：stageFocus = 显式段 focus 映射（resolveStageFocus，stages 恰 3 段
  // 且切点未回退才写键）——growth-projection focusBoost 消费；无 stages 时不再靠
  // 「openAt == 段起点」巧合等价（切点回退缺省后会让未声明线意外获 ×1.5）。
  // 双口径注意（Coherence #3）：stageMatrices.bounds 与本处 derivedStageBounds 取值规则
  // 不同源——前者 stages 恰 3 段才用切点、否则 stageBounds 占比回退；后者恒走
  // deriveStageBounds。stages 非 3 段且恰 2 个有效切点时两 bounds 可能不同值（A2 裁决内
  // 缝隙，W3 展示层需分别消费，勿假设二者一致）
  const stageFocusMap = resolveStageFocus(
    stageAllocation?.stages,
    lineSchedule,
    totalLevels
  );
  const lineScheduleEcho = lineSchedule
    ? {
        lines: clampLineSchedule(lineSchedule, totalLevels).lines,
        derivedKeyNodes: deriveKeyNodes(lineSchedule, totalLevels),
        derivedStageBounds: deriveStageBounds(stageAllocation?.stages, lineSchedule, totalLevels),
        ...(stageFocusMap
          ? {
              stageFocus: {
                early: stageFocusMap.focusLines[0],
                mid: stageFocusMap.focusLines[1],
                late: stageFocusMap.focusLines[2],
              } as const,
            }
          : {}),
      }
    : undefined;

  const base = {
    moduleType: "battle" as const,
    ...structural,
    ...(focusOverride !== undefined ? { focusOverride } : {}),
    combatPacing,
    expectedCombatDuration,
    attributeDesign: {
      primary: attributeDesign.primary,
      secondary: attributeDesign.secondary,
      growthModels,
    },
    attributeGrowthTable,
    damageSimulations,
    damageFormulaFramework: {
      baseFormula: damageFormula.baseFormula,
      coefficients: damageFormula.coefficients,
      description: `伤害公式类型: ${damageFormula.type}`,
    },
    skillFramework,
    attributeBudgets,
    // Review 修复（P1-A）：lineScheduleEcho 进 base——powerProfile 经 computePowerAtDay
    // 消费同调度权重，维持「powerProfile.power = 投影末锚 totalPower」同源契约
    //（growth-projection.ts docstring 所载 W0 不变量；曾因 base 不含 echo 分裂 28.6%）
    ...(lineScheduleEcho !== undefined ? { lineScheduleEcho } : {}),
  };

  // W0 战力模型 v2：满级口径战力画像——与成长推演末锚同源（computePowerAtDay 单源，
  // day=HORIZON_DAY 与投影末锚同 day；技能倍率用 skillDetails 按 count 加权均值
  // （weightedSkillMultiplier，无 skillDetails → 1.0），与上方 avgSkillMultiplier
  // 简单均值（damageSimulations 展示用）口径不同且不在本波次统一）
  return {
    ...base,
    // questionnaire-ia W2 深档题：敌人强度基准乘数恒等透传（引擎不参与计算，
    // 难度镜像 tiers 全局乘数基准由 DifficultyMirrorBlock 消费）；无锚点不写键（形状最小）
    ...(anchors.enemyStrengthBaseline !== undefined
      ? { enemyStrengthBaseline: anchors.enemyStrengthBaseline }
      : {}),
    // V8 W2-T2：阶段化矩阵（声明才写键，缺省恒等 S1）
    ...(stageMatrices !== undefined ? { stageMatrices } : {}),
    powerProfile: computePowerAtDay(base, HORIZON_DAY).stats,
  };
}
