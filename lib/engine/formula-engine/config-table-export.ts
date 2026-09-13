/**
 * 配置表草稿导出（V10-W3 T2：方案 → 表草稿 round-trip 最小版）
 *
 * 规划 confirmed 产物 → 工作区规范化表草稿（与 workspaces 下各模块 tables 目录的
 * 表文件同构：行对象数组 + 点分复合列名），锚定 2 张表（Spec §二建模）：
 * - level 等级成长表：level confirmed（每 levelType 一张）——关卡序号列（1..N 等差+1）/
 *   难度分·推荐战力·奖励列（level.ts 锚点插值 interpolateFromAnchors 逐级取整的产物直映射；
 *   「经验列」为契约可选支——level confirmed 无经验数据源，最小版不发明数据，诚实缺席）
 * - battle 属性投放矩阵表：battle confirmed（growthLines × allocationMatrix 直映射）——
 *   行=成长线，列=attack/defense/hp/speed/special 投放值（列头经 buildMatrixColumns 单源）
 *
 * round-trip 判据（「生成与逆向同一数学基底」的可执行证明，只对显式参数列主张）：
 * 导出表 → lib/table/pattern.ts（detectColumnPattern / inferColumnRule）重新解析 →
 * 等差列还原 diff、等比列还原 ratio，与生成参数逐字段相等（容差 ±0.5 取整口径）；
 * 曲线插值列（exponential/sigmoid 取整后无单一规则）模式识别不命中时如实标注
 * 「非规则列」，不算失败（N2 诚实纪律）。
 *
 * 纯函数：无 LLM、无 IO、无随机（N1），相同输入产出相同输出；独立导出不走
 * computeFromIntent intent 路由（growth-projection / experience-expectation 先例），
 * 由 experience-expectation（configTableRefs 填充）与 export_deliverable
 * （scope=config-tables inline 载荷）同源消费。
 */

import type { ComputedBattleData, ComputedLevelData } from "@/lib/types/planning";
import { buildMatrixColumns } from "./battle";

// ==================== 契约类型 ====================

/** 工作区规范化表行（与工作区 tables 目录表文件同构：点分复合列名） */
export type ConfigTableRow = Record<string, number | string>;

/** 表草稿导出覆盖的模块（最小版锚定 2 张表，其余模块显式缺席） */
export type ConfigTableModule = "level" | "battle";

/** 一张表草稿：模块 + 工作区表名（模块目录/表名）+ 工作区相对路径 + 行数据 */
export interface ConfigTableDraft {
  module: ConfigTableModule;
  /** 工作区表名（loadTableRows / persistTableRows 的 table 参数口径，如 "level/main-等级成长"） */
  tableName: string;
  /** 工作区相对路径（tables/<tableName>.json） */
  path: string;
  rows: ConfigTableRow[];
}

/** configTableRefs 开通模块条目（level 每 levelType 一张表 → tables 数组） */
export interface ConfigTableRefEntry {
  tables: Array<{ tableName: string; path: string }>;
}

/** configTableRefs 未开通/缺席模块条目（N2：显式 unavailable + 原因，不静默空缺） */
export interface ConfigTableUnavailableEntry {
  unavailable: true;
  reason: string;
}

export type ConfigTableRefs = Record<
  string,
  ConfigTableRefEntry | ConfigTableUnavailableEntry
>;

/** 派生源（confirmed 产物子形状；键可选 = 对应模块 confirmed 缺席） */
export interface ConfigTableSources {
  battle?: Pick<ComputedBattleData, "growthLines" | "attributeCategories" | "allocationMatrix">;
  level?: Pick<ComputedLevelData, "levelTypes">;
}

/** deriveConfigTableDrafts 聚合产物 */
export interface ConfigTableDraftBundle {
  /** 全部表草稿（level 各表在前、battle 在后，确定性顺序） */
  drafts: ConfigTableDraft[];
  /** 全景 refs（开通模块真实引用 + 缺席模块 unavailable + 未开通模块 unavailable） */
  refs: ConfigTableRefs;
}

/** 未开通模块的缺席原因（最小版纪律：全模块铺开进 V11） */
const NOT_OPENED_REASON =
  "最小版未开通：配置表草稿生成当前仅覆盖 level/battle 两模块，全模块铺开进 V11";

/** 开通模块 confirmed 缺席/无可派生内容的缺席原因 */
const absentReason = (module: string): string =>
  `${module} confirmed 缺席或无可派生内容（表草稿生成需要该模块已确认的规划产物）`;

/** 最小版未开通的模块（economy/progression/gacha——恒 unavailable，V11 铺开） */
const NOT_OPENED_MODULES = ["economy", "progression", "gacha"] as const;

// ==================== level 等级成长表 ====================

/**
 * level confirmed → 等级成长表草稿（每 levelType 一张表，表名 level/<id>-等级成长）。
 *
 * 列：关卡序号（等差 +1）/ 关卡名称 / 难度分 / 推荐战力（clear_only 落 0 哨兵）/
 * 奖励.<资源id>（rewardEstimate 逐资源一列）。levels 为空的 levelType 跳过
 * （不产空表——诚实缺席，由 refs 侧 unavailable 承载原因）。
 */
export function deriveLevelTable(
  level: Pick<ComputedLevelData, "levelTypes">
): ConfigTableDraft[] {
  const drafts: ConfigTableDraft[] = [];
  for (const lt of level?.levelTypes ?? []) {
    const levels = lt?.levels;
    if (!Array.isArray(levels) || levels.length === 0) continue;

    const rows: ConfigTableRow[] = levels.map((row) => {
      const r: ConfigTableRow = {
        关卡序号: row.levelIndex,
        关卡名称: row.levelName,
        难度分: row.difficultyScore,
        推荐战力: row.recommendedPower,
      };
      for (const [rid, value] of Object.entries(row.rewardEstimate ?? {})) {
        if (typeof value === "number" && Number.isFinite(value)) {
          r[`奖励.${rid}`] = value;
        }
      }
      return r;
    });

    const tableName = `level/${lt.id}-等级成长`;
    drafts.push({ module: "level", tableName, path: `tables/${tableName}.json`, rows });
  }
  return drafts;
}

// ==================== battle 属性投放矩阵表 ====================

/**
 * battle confirmed → 属性投放矩阵表草稿（单张，行=成长线，列=投放值直映射）。
 *
 * 列头经 buildMatrixColumns 单源（四维固定列 + special 聚合列——classic-4 无
 * special 列时矩阵退化为 4 列，extended-6/special-flow 下 special 列头为特殊
 * 类目名拼接）。growthLines/allocationMatrix 缺失或为空 → null（调用方落
 * unavailable 引用）。
 */
export function deriveBattleMatrixTable(
  battle: ConfigTableSources["battle"]
): ConfigTableDraft | null {
  const lines = battle?.growthLines ?? [];
  const matrix = battle?.allocationMatrix ?? [];
  if (lines.length === 0 || matrix.length === 0) return null;

  const columns = buildMatrixColumns(battle?.attributeCategories ?? []);
  const rowByLine = new Map(matrix.map((m) => [m.growthLineId, m]));

  const rows: ConfigTableRow[] = [];
  for (const line of lines) {
    const matrixRow = rowByLine.get(line.id);
    if (!matrixRow) continue;
    const row: ConfigTableRow = {
      成长线ID: line.id,
      成长线: line.name,
    };
    for (const col of columns) {
      const cell = matrixRow.allocations.find((a) => a.attributeId === col.id);
      row[`投放.${col.label}`] = cell?.weightPct ?? 0;
    }
    rows.push(row);
  }
  if (rows.length === 0) return null;

  const tableName = "battle/属性投放矩阵";
  return { module: "battle", tableName, path: `tables/${tableName}.json`, rows };
}

// ==================== refs / 草稿聚合（单源） ====================

/**
 * confirmed 源 → 表草稿 + 全景 configTableRefs（单源装配）：
 * experience-expectation（refs 填充）与 export_deliverable（scope=config-tables
 * 载荷）同源消费，防双份实现漂移（buildExperienceExpectationInput 先例）。
 */
export function deriveConfigTableDrafts(sources: ConfigTableSources): ConfigTableDraftBundle {
  const levelDrafts = deriveLevelTable(sources.level ?? { levelTypes: [] });
  const battleDraft = deriveBattleMatrixTable(sources.battle);

  const drafts = battleDraft ? [...levelDrafts, battleDraft] : [...levelDrafts];

  const refs: ConfigTableRefs = {
    level:
      levelDrafts.length > 0
        ? { tables: levelDrafts.map(({ tableName, path }) => ({ tableName, path })) }
        : { unavailable: true, reason: absentReason("level") },
    battle: battleDraft
      ? { tables: [{ tableName: battleDraft.tableName, path: battleDraft.path }] }
      : { unavailable: true, reason: absentReason("battle") },
  };
  for (const moduleKey of NOT_OPENED_MODULES) {
    refs[moduleKey] = { unavailable: true, reason: NOT_OPENED_REASON };
  }

  return { drafts, refs };
}
