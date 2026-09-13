/**
 * 等级域阶段边界缺省（V8 W2-T1 阶段口径单源）：
 * early ≤20%、mid 20-70%、late ≥70%。
 *
 * 两构念约定（V8 W3-T5 Spec R6，双向记录——两消费族各按其构念消费边界）：
 * - 占比边界 = 段末含端：early = [1..⌈frac·L⌉]（⌈0.2L⌉ 为 early 段末级、
 *   该级属 early）。消费族：battle stageMatrices、progression speedComparison
 *   与 stageFactorAtLevel（均经 stageBoundsToLevels 绝对等级单源组段/判段）。
 * - openAt 切换 = 段首含端：L ≥ openAt 即新段（openAt 为该段首级）。消费族：
 *   battle lineWeight、stages deriveStageBounds / resolveStageFocus。
 *
 * level-reward computeRewardSchedule 内联 phases 数组现值迁入的口径单源；
 * progression buildSpeedComparison 阶段切分同样消费此常量（两套口径合一，
 * Spec 裁决 A1：三等分 → [0.2, 0.7] 为已批准缺省行为变化）。
 */
export const STAGE_BOUNDS_DEFAULT: [number, number] = [0.2, 0.7];

// ==================== V8 W2-T6a 养成线调度（层 2，确定性推导纯函数）====================
// 零 IO、零依赖：相同输入产出相同输出（无 LLM、无随机）。
// 消费方：battle（stageMatrices 边界 + lineScheduleEcho）、growth-projection（focusBoost 判定）。

/** 单条养成线的开放调度：openAt = 开放等级，unlockLevels = 档位解锁（高阶兵式台阶） */
export interface LineScheduleEntry {
  openAt: number;
  unlockLevels?: number[];
}

/** 养成线调度（structuralDecisions 第 11 键的形状）：lines 键 = 成长线 id */
export interface LineSchedule {
  lines: Partial<Record<string, LineScheduleEntry>>;
}

/** 阶段重点线（stageAllocation.stages 的元素）：focusLines[0] 为主 focus 线 */
export interface StageFocus {
  name: string;
  focusLines: string[];
}

/** 钳制进 [1, maxLevel]（maxLevel 非法值防御为 ≥1） */
function clampLevel(value: number, maxLevel: number): number {
  return Math.min(Math.max(1, maxLevel), Math.max(1, value));
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 关键节点推导（Spec R6 / S9a）：事件 = ∪_line({openAt} ∪ unlockLevels)，
 * 钳制进 [1, maxLevel]，去重升序。等级 1 为全程起点、不计节点
 * （S9a 锚定：hero@1 不入产物，节点 = 开放事件 ∪ 解锁档 − 起点）。
 * lineSchedule 缺失 → []（缺省恒等）。
 */
export function deriveKeyNodes(
  lineSchedule: LineSchedule | undefined,
  maxLevel: number
): number[] {
  if (!lineSchedule?.lines) return [];
  const events = new Set<number>();
  for (const entry of Object.values(lineSchedule.lines)) {
    if (!entry) continue;
    const raw = [entry.openAt, ...(entry.unlockLevels ?? [])];
    for (const v of raw) {
      if (!isFiniteNumber(v)) continue;
      const clamped = clampLevel(v, maxLevel);
      if (clamped <= 1) continue; // 起点过滤
      events.add(clamped);
    }
  }
  return [...events].sort((a, b) => a - b);
}

/** 占比阶段边界 → 绝对等级对（⌈L×frac⌉，钳制 [1,L]；降序归一、非有限回退缺省） */
export function stageBoundsToLevels(
  bounds: [number, number],
  maxLevel: number
): [number, number] {
  const valid =
    isFiniteNumber(bounds[0]) && isFiniteNumber(bounds[1])
      ? bounds
      : STAGE_BOUNDS_DEFAULT;
  const a = clampLevel(Math.ceil(valid[0] * Math.max(1, maxLevel)), maxLevel);
  const b = clampLevel(Math.ceil(valid[1] * Math.max(1, maxLevel)), maxLevel);
  return a <= b ? [a, b] : [b, a];
}

/**
 * 段边界推导（Spec R6 / 裁决 A2）：每阶段主 focus 线（focusLines[0]）的 openAt
 * 为切换点（该线开放即该阶段重点开始）。恰 2 个有效切换点 → 返回升序对；
 * 否则（无 stages / 段数不齐 / focus 线未声明 openAt）回退 STAGE_BOUNDS_DEFAULT
 * 占比换算的绝对等级。
 * 返回口径恒为绝对等级：等级 1 为起点、非阶段间边界（切换点须 > 1）。
 */
/** 阶段间切换点收集：各段主 focus 线（focusLines[0]）openAt 有效且 clamp 后 >1 的去重集 */
function collectStageSwitches(
  stages: StageFocus[] | undefined,
  lineSchedule: LineSchedule | undefined,
  maxLevel: number
): Set<number> {
  const switches = new Set<number>();
  if (stages && lineSchedule?.lines) {
    for (const stage of stages) {
      const focusId = stage?.focusLines?.[0];
      if (focusId === undefined) continue;
      const openAt = lineSchedule.lines[focusId]?.openAt;
      if (!isFiniteNumber(openAt)) continue; // focus 线未声明 → 切换点无效
      const clamped = clampLevel(openAt, maxLevel);
      if (clamped <= 1) continue; // 起点非阶段间边界
      switches.add(clamped);
    }
  }
  return switches;
}

export function deriveStageBounds(
  stages: StageFocus[] | undefined,
  lineSchedule: LineSchedule | undefined,
  maxLevel: number
): [number, number] {
  const switches = collectStageSwitches(stages, lineSchedule, maxLevel);
  if (switches.size === 2) {
    const [a, b] = [...switches].sort((x, y) => x - y);
    return [a, b];
  }
  return stageBoundsToLevels(STAGE_BOUNDS_DEFAULT, maxLevel);
}

/** 段 focus 显式映射（resolveStageFocus 产物）：三段边界 + 各段主 focus 线 */
export interface StageFocusMap {
  /** 段边界（绝对等级，与 deriveStageBounds 切点分支同源） */
  bounds: [number, number];
  /** [early, mid, late] 三段主 focus 线 id（stages[].focusLines[0]） */
  focusLines: [string, string, string];
}

/**
 * 段 focus 显式映射（Review 修复 P1-B）：stages 恰 3 段、每段主 focus 线已声明、
 * 切点恰 2 个有效（= deriveStageBounds 未回退缺省）→ 返回 bounds + 三段 focus 线；
 * 否则 null（无 stages / 非恰 3 段 / 切点回退——focusBoost 无语义来源不触发）。
 * 替代旧「openAt == 段起点」巧合等价：切点回退缺省后该判定会在无意图处放大
 * （未声明线缺省 openAt 1 与首段起点 1 重合 → 意外 ×1.5）。
 */
export function resolveStageFocus(
  stages: StageFocus[] | undefined,
  lineSchedule: LineSchedule | undefined,
  maxLevel: number
): StageFocusMap | null {
  if (!stages || stages.length !== 3) return null;
  const switches = collectStageSwitches(stages, lineSchedule, maxLevel);
  if (switches.size !== 2) return null;
  const focusLines = stages.map((s) => s?.focusLines?.[0]);
  if (focusLines.some((f) => f === undefined)) return null;
  const [a, b] = [...switches].sort((x, y) => x - y);
  return { bounds: [a, b], focusLines: focusLines as [string, string, string] };
}

/**
 * 调度回显净化（battle computed.lineScheduleEcho.lines 用）：
 * openAt / unlockLevels 逐值 clamp 进 [1, maxLevel]（原样回显，仅越界钳制，
 * 不排序不去重）；openAt 非有限数的线整体丢弃、unlockLevels 非有限值过滤。
 */
export function clampLineSchedule(
  lineSchedule: LineSchedule,
  maxLevel: number
): LineSchedule {
  const lines: Partial<Record<string, LineScheduleEntry>> = {};
  for (const [id, entry] of Object.entries(lineSchedule.lines ?? {})) {
    if (!entry || !isFiniteNumber(entry.openAt)) continue;
    const unlockLevels = Array.isArray(entry.unlockLevels)
      ? entry.unlockLevels.filter(isFiniteNumber).map((v) => clampLevel(v, maxLevel))
      : undefined;
    lines[id] =
      unlockLevels !== undefined
        ? { openAt: clampLevel(entry.openAt, maxLevel), unlockLevels }
        : { openAt: clampLevel(entry.openAt, maxLevel) };
  }
  return { lines };
}
