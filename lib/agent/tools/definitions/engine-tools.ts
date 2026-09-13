/**
 * 计算类工具 — 确定性引擎的薄壳包装（数值正确性不经过 LLM）
 *
 * battle_simulate / simulate_gacha / compute_power 三个工具分别包装
 * formula-engine 的 simulateBattle / runGachaSimulation+simulateTieredDraws /
 * computePowerStats。中文属性键 → 引擎键的映射即 schema 适配层。
 */

import {
  simulateBattle,
  computePowerStats,
  runGachaSimulation,
  simulateTieredDraws,
  evalExpression,
} from "@/lib/engine/formula-engine";
import type {
  BattleSimPlayerPanel,
  BattleSimEnemyPanel,
  TieredPoolTier,
} from "@/lib/engine/formula-engine";
import { inferColumnRule, type RuleFit } from "@/lib/table/pattern";
import { inferPairRelation, inferTableRelations } from "@/lib/table/relation";
import { join } from "path";
import { loadTableRows, tablePath } from "../../storage";
import type { ToolDefinition } from "../protocol";

/** 中文属性键（工作区表口径）→ 引擎战力键；crit 引擎侧为百分数口径（0~100） */
const POWER_ATTR_MAP: Record<string, string> = {
  攻击: "attack", 攻击力: "attack", attack: "attack", atk: "attack",
  防御: "defense", defense: "defense", def: "defense",
  体力: "hp", 生命: "hp", 生命值: "hp", hp: "hp",
  攻速: "speed", 攻击速度: "speed", 速度: "speed", speed: "speed", spd: "speed",
  暴击率: "crit", 暴击: "crit", crit: "crit",
};

function toEngineAttrs(raw: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const engineKey = POWER_ATTR_MAP[key.toLowerCase()] ?? POWER_ATTR_MAP[key];
    if (!engineKey) continue;
    out[engineKey] = engineKey === "crit" && value > 0 && value <= 1 ? value * 100 : value;
  }
  return out;
}

/** 推断规则 → audit_column/apply_curve 可直接消费的表达式（变量 i=行序 0 起） */
function ruleExpression(rule: RuleFit): string {
  switch (rule.type) {
    case "arithmetic":
      return `${rule.first} + ${rule.diff} * i`;
    case "geometric":
      return `${rule.first} * ${rule.ratio} ^ i`;
    case "power":
      return `${rule.first} * (i + 1) ^ ${rule.exponent}`;
  }
}

function ruleLabel(rule: RuleFit): string {
  switch (rule.type) {
    case "arithmetic":
      return `等差 ${rule.first} + ${rule.diff}×i`;
    case "geometric":
      return `等比 ${rule.first}×${rule.ratio}^i`;
    case "power":
      return `幂律 ${rule.first}×(i+1)^${rule.exponent}`;
  }
}

export const engineToolDefinitions: ToolDefinition[] = [
  {
    name: "battle_simulate",
    description:
      "战斗模拟：玩家面板 × 敌人面板的对拼计算（确定性引擎，非 LLM 估算）。返回击杀刀数、被击刀数、咬合比 killRatio、评级（easy/balanced/tight/impossible）、期望 DPS；可选 Monte Carlo 胜率。用于改数值后评估战斗咬合变化。",
    parameters: {
      type: "object",
      properties: {
        player: {
          type: "object",
          description: "玩家面板（来自 hero/成长表 + 装备加成）",
          properties: {
            attack: { type: "number", description: "攻击" },
            hp: { type: "number", description: "体力/生命" },
            critRate: { type: "number", description: "暴击率（0~1）" },
            critDamage: { type: "number", description: "暴击伤害倍率（如 1.3）" },
            attackSpeed: { type: "number", description: "攻击速度（每秒刀数）" },
          },
          required: ["attack", "hp", "critRate", "critDamage", "attackSpeed"],
        },
        enemy: {
          type: "object",
          description: "敌人面板（来自 enemy/等级成长）",
          properties: {
            hp: { type: "number" },
            damage: { type: "number", description: "敌人每刀伤害" },
            blocking: { type: "number", description: "格挡值（当前模型不消耗）" },
          },
          required: ["hp", "damage"],
        },
        simulations: { type: "number", description: "Monte Carlo 局数（默认 0 不算胜率）" },
      },
      required: ["player", "enemy"],
    },
    access: "read",
    module: "engine",
    execute: async (params) => {
      const p = params as {
        player: BattleSimPlayerPanel;
        enemy: BattleSimEnemyPanel;
        simulations?: number;
      };
      try {
        return { success: true as const, data: simulateBattle(p) };
      } catch (error) {
        return { success: false as const, error: (error as Error).message };
      }
    },
  },
  {
    name: "simulate_gacha",
    description:
      "概率模拟（确定性引擎）：mode=tiers 模拟无保底分层概率池（rogue 技能三选一、宝箱品质掉落）N 次抽取的各层次数分布与分位；mode=pity 模拟带保底的抽卡（基础概率+软/硬保底）抽数分布与期望。",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["tiers", "pity"], description: "tiers=分层池抽取；pity=保底抽卡" },
        tiers: {
          type: "array",
          description: "mode=tiers 必填：各层名称与单次命中率（概率和须为 1）",
          items: {
            type: "object",
            properties: { name: { type: "string" }, rate: { type: "number" } },
            required: ["name", "rate"],
          },
        },
        draws: { type: "number", description: "mode=tiers：单轮抽取次数（如一局 15 次三选一 = 15 抽）" },
        iterations: { type: "number", description: "模拟轮数（默认 1000）" },
        baseRate: { type: "number", description: "mode=pity：基础概率（如 0.006）" },
        hardPity: { type: "number", description: "mode=pity：硬保底抽数" },
        softPityStart: { type: "number", description: "mode=pity：软保底起始抽数" },
        softPityIncrement: { type: "number", description: "mode=pity：软保底每抽概率增量" },
      },
      required: ["mode"],
    },
    access: "read",
    module: "engine",
    execute: async (params) => {
      const p = params as {
        mode: "tiers" | "pity";
        tiers?: TieredPoolTier[];
        draws?: number;
        iterations?: number;
        baseRate?: number;
        hardPity?: number;
        softPityStart?: number;
        softPityIncrement?: number;
      };
      try {
        if (p.mode === "tiers") {
          if (!p.tiers?.length || !p.draws) {
            return { success: false as const, error: "mode=tiers 需要 tiers（层列表）与 draws（抽取次数）" };
          }
          return {
            success: true as const,
            data: {
              // 回显输入 + 参数来源声明：模拟参数若非项目数据，agent 必须向用户说明是假设
              assumptions: { mode: "tiers", tiers: p.tiers, draws: p.draws, iterations: p.iterations ?? 1000, source: "调用参数——若非来自项目数据请在回答中声明为假设" },
              ...simulateTieredDraws(p.tiers, p.draws, Math.random, p.iterations ?? 1000),
            },
          };
        }
        if (p.baseRate === undefined || p.hardPity === undefined || p.softPityStart === undefined || p.softPityIncrement === undefined) {
          return { success: false as const, error: "mode=pity 需要 baseRate/hardPity/softPityStart/softPityIncrement" };
        }
        const result = runGachaSimulation(
          { baseRate: p.baseRate, pity: { hardPity: p.hardPity, softPityStart: p.softPityStart, softPityIncrement: p.softPityIncrement } },
          p.iterations ?? 10000,
        );
        // distribution 是 Map，序列化前转普通对象
        return {
          success: true as const,
          data: {
            assumptions: { mode: "pity", baseRate: p.baseRate, hardPity: p.hardPity, softPityStart: p.softPityStart, softPityIncrement: p.softPityIncrement, iterations: p.iterations ?? 10000, source: "调用参数——若非来自项目数据请在回答中声明为假设" },
            averagePulls: result.averagePulls,
            medianPulls: result.medianPulls,
            stdDev: result.stdDev,
            percentiles: result.percentiles,
            distribution: Object.fromEntries(result.distribution),
          },
        };
      } catch (error) {
        return { success: false as const, error: (error as Error).message };
      }
    },
  },
  {
    name: "compute_power",
    description:
      "战力计算（确定性引擎，EHP×EDPS 开方模型）：输入属性面板（中文键如 攻击/体力/暴击率/暴击伤害），返回战力、EDPS、EHP 与各属性边际价值。用于对比改数值前后的战力变化。",
    parameters: {
      type: "object",
      properties: {
        attrs: {
          type: "object",
          description: "属性面板，键可用中文（攻击/体力/暴击率/暴击伤害/攻速/防御）或英文",
          additionalProperties: { type: "number" },
        },
        stdAtk: { type: "number", description: "满级标准攻击锚（默认取面板攻击值）" },
        stdSpeed: { type: "number", description: "满级标准速度锚（默认 1，攻速倍率口径）" },
      },
      required: ["attrs"],
    },
    access: "read",
    module: "engine",
    execute: async (params) => {
      const p = params as { attrs: Record<string, number>; stdAtk?: number; stdSpeed?: number };
      const raw = p?.attrs;
      if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) {
        return { success: false as const, error: "缺少 attrs 属性面板" };
      }
      const attrs = toEngineAttrs(raw);
      const attack = attrs.attack ?? Object.values(raw)[0];
      try {
        const stats = computePowerStats(attrs, {
          // 乘法减伤型（本项目无减法公式证据，近似声明）
          formulaType: "multiplicative",
          coefficients: {},
          skillMultiplier: 1,
          critDmgMult: attrs.crit !== undefined && raw["暴击伤害"] !== undefined ? raw["暴击伤害"] : 1.3,
          stdAtk: p.stdAtk ?? attack,
          stdSpeed: p.stdSpeed ?? 1,
        });
        return {
          success: true as const,
          data: {
            ...stats,
            assumptions: ["乘法减伤型战力公式（本项目无减法公式证据）", "skillMultiplier=1（无技能倍率数据）"],
          },
        };
      } catch (error) {
        return { success: false as const, error: (error as Error).message };
      }
    },
  },
  {
    name: "power_curve",
    description:
      "战力曲线（批量）：读成长表逐行（可采样）属性面板调 computePowerStats，一次产出「等级→战力」全曲线与形态摘要（首/中位/末档战力、成长倍率、形态判定：匀速/后期加速/台阶断点）。属性列自动按常用名识别（攻击/攻击力→attack、体力/生命→hp、防御→defense、攻速/速度→speed、暴击率→crit），识别不到时用 columns 显式指定。适合全曲线分析与成长×装备联合推导，替代多次单点 compute_power。",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "成长表名（如 hero/成长表）" },
        levelColumn: { type: "string", description: "等级/序号列名，缺省取首列" },
        columns: {
          type: "object",
          description: "显式列映射 {attack:'属性.攻击', hp:'属性.体力', defense?, speed?, crit?}——自动识别失败或需换列时用",
          additionalProperties: { type: "string" },
        },
        sampleEvery: { type: "number", description: "采样间隔（默认自动：行数>60 时取 ceil(行数/60)），首末行恒在采样内" },
      },
      required: ["table"],
    },
    access: "read",
    module: "workspace",
    execute: async (params, ctx) => {
      const p = (params ?? {}) as {
        table?: string;
        levelColumn?: string;
        columns?: Record<string, string>;
        sampleEvery?: number;
      };
      if (!p.table) return { success: false as const, error: "缺少 table" };
      if (!ctx?.workspaceRoot) return { success: false as const, error: "缺少工作区上下文" };
      const rows = loadTableRows(ctx.workspaceRoot, p.table);
      if (!rows) return { success: false as const, error: `表不存在或不可读: ${p.table}` };
      if (rows.length < 2) return { success: false as const, error: "行数不足（需 ≥2 行才能成曲线）" };

      const levelCol = p.levelColumn ?? Object.keys(rows[0])[0];
      // 列映射：显式 columns 优先；否则全列名过 POWER_ATTR_MAP 自动识别
      //（含命名空间前缀回退：「属性.攻击」→ 攻击 → attack）
      const resolveEngineKey = (key: string): string | undefined => {
        const direct = POWER_ATTR_MAP[key] ?? POWER_ATTR_MAP[key.toLowerCase()];
        if (direct) return direct;
        const tail = key.split(/[.。_\-/]/).pop()!;
        return POWER_ATTR_MAP[tail] ?? POWER_ATTR_MAP[tail.toLowerCase()];
      };
      const colToEngine = new Map<string, string>();
      for (const [engineKey, col] of Object.entries(p.columns ?? {})) {
        if (typeof col === "string") colToEngine.set(col, engineKey);
      }
      if (colToEngine.size === 0) {
        for (const key of Object.keys(rows[0])) {
          const engineKey = resolveEngineKey(key);
          if (engineKey) colToEngine.set(key, engineKey);
        }
      }
      const engineKeys = new Set(colToEngine.values());
      if (colToEngine.size === 0) {
        return { success: false as const, error: "未识别到属性列（可用 columns 显式指定，如 {attack:'属性.攻击', hp:'属性.体力'}）" };
      }
      if (!engineKeys.has("attack") || !engineKeys.has("hp")) {
        return { success: false as const, error: "战力模型至少需要攻击(attack)与体力(hp)两列——用 columns 显式指定" };
      }

      const sampleEvery = Math.max(1, Math.ceil(p.sampleEvery ?? rows.length / 60));
      const points: Array<{ level: number | string; power: number }> = [];
      for (let i = 0; i < rows.length; i++) {
        if (i !== 0 && i !== rows.length - 1 && i % sampleEvery !== 0) continue;
        const attrs: Record<string, number> = {};
        for (const [col, engineKey] of colToEngine) {
          const v = rows[i][col];
          if (typeof v === "number") attrs[engineKey] = engineKey === "crit" && v > 0 && v <= 1 ? v * 100 : v;
        }
        try {
          const stats = computePowerStats(attrs, {
            formulaType: "multiplicative",
            coefficients: {},
            skillMultiplier: 1,
            critDmgMult: 1.3,
            stdAtk: attrs.attack,
            stdSpeed: 1,
          });
          const lv = rows[i][levelCol];
          points.push({ level: typeof lv === "number" ? lv : String(lv ?? i + 1), power: Math.round(stats.power) });
        } catch {
          // 行属性残缺跳过，不阻断整条曲线
        }
      }
      if (points.length < 2) return { success: false as const, error: "有效采样点不足（属性列存在但行值非数值？）" };

      // 形态判定：相邻档比率分析（与 audit_column 指纹口径互补）
      const ratios = points.slice(1).map((pt, i) => (points[i].power > 0 ? pt.power / points[i].power : 1));
      const sortedR = [...ratios].sort((a, b) => a - b);
      const medianR = sortedR[Math.floor(sortedR.length / 2)];
      const maxR = sortedR[sortedR.length - 1];
      const spikeIdx = ratios.findIndex((r) => r === maxR);
      const q = Math.max(1, Math.ceil(ratios.length / 4));
      const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
      let shape: string;
      if (maxR > medianR * 1.8 && maxR > 1.15) {
        shape = `台阶/断点（${points[spikeIdx + 1]?.level} 档后战力跳升 ×${maxR.toFixed(2)}——配合 audit_column 可定位该档手调）`;
      } else if (avg(ratios.slice(-q)) > avg(ratios.slice(0, q)) * 1.15) {
        shape = "后期加速（指数样）";
      } else {
        shape = "匀速成长（近线性）";
      }

      const powers = points.map((x) => x.power).sort((a, b) => a - b);
      return {
        success: true as const,
        data: {
          points,
          summary: {
            rowsTotal: rows.length,
            sampled: points.length,
            sampleEvery,
            first: points[0],
            median: { level: points[Math.floor(points.length / 2)].level, power: powers[Math.floor(points.length / 2)] },
            last: points[points.length - 1],
            multiple: +(points[points.length - 1].power / Math.max(1, points[0].power)).toFixed(1),
            shape,
          },
          assumptions: ["乘法减伤型战力公式（与 compute_power 同源）", "skillMultiplier=1（无技能倍率数据）"],
        },
      };
    },
  },
  {
    name: "eval_formula",
    description:
      "确定性求值数值公式（四则/幂/括号/变量，支持中文变量名）。用于验证锚点公式、快速算数——数值永远由引擎算而非估算。",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "公式，如 100 * 1.08 ^ (等级 - 1)" },
        variables: { type: "object", description: "变量取值，如 {等级: 60}", additionalProperties: { type: "number" } },
      },
      required: ["expression"],
    },
    access: "read",
    module: "engine",
    execute: async (params) => {
      const p = (params ?? {}) as { expression?: string; variables?: Record<string, number> };
      if (!p.expression) return { success: false as const, error: "缺少 expression" };
      try {
        return { success: true as const, data: { value: evalExpression(p.expression, p.variables ?? {}) } };
      } catch (error) {
        return { success: false as const, error: (error as Error).message };
      }
    },
  },
  {
    name: "audit_column",
    description:
      "列审计（对账）：用锚点公式重算指定列的每一行（变量 x=varColumn 该行值，i=行序），报告偏离公式超过阈值（默认 1%）的行——识别成长曲线的手调断点。先看 list_tables 的 columnPatterns 了解列的既有模式。",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "目标表名" },
        column: { type: "string", description: "被审计的数值列" },
        expression: { type: "string", description: "期望公式（x=varColumn 值，i=行序），如 100 + 5 * (x - 1)" },
        varColumn: { type: "string", description: "作为变量 x 的列（通常是等级/序号列）" },
        thresholdPct: { type: "number", description: "偏离阈值百分比（默认 1）" },
      },
      required: ["table", "column", "expression", "varColumn"],
    },
    access: "read",
    module: "workspace",
    execute: async (params, ctx) => {
      const p = (params ?? {}) as {
        table?: string;
        column?: string;
        expression?: string;
        varColumn?: string;
        thresholdPct?: number;
      };
      if (!p.table || !p.column || !p.expression || !p.varColumn) {
        return { success: false as const, error: "需要 table/column/expression/varColumn" };
      }
      if (!tablePath(ctx.workspaceRoot, p.table)) {
        return { success: false as const, error: `非法表名: ${p.table}` };
      }
      const rows = loadTableRows(ctx.workspaceRoot, p.table);
      if (!rows) return { success: false as const, error: `表不存在: ${p.table}` };
      const threshold = p.thresholdPct ?? 1;
      const outliers: { index: number; x: number; value: number; expected: number; deviationPct: number }[] = [];
      // 跳过行必须显式计数：列名打错或列含非数值时静默跳过会把「没核对」伪装成「核对通过」
      let skippedRows = 0;
      rows.forEach((row, i) => {
        const actual = row[p.column!];
        const x = row[p.varColumn!];
        if (typeof actual !== "number" || typeof x !== "number") {
          skippedRows += 1;
          return;
        }
        let expected: number;
        try {
          expected = evalExpression(p.expression!, { x, i });
        } catch (error) {
          throw new Error(`第 ${i} 行公式求值失败: ${(error as Error).message}`);
        }
        const deviationPct = ((actual - expected) / expected) * 100;
        if (Math.abs(deviationPct) > threshold) {
          outliers.push({
            index: i,
            x,
            value: actual,
            expected: Number(expected.toFixed(4)),
            deviationPct: Number(deviationPct.toFixed(2)),
          });
        }
      });
      const checkedRows = rows.length - skippedRows;
      // 全部行被跳过 = 列名/varColumn 错误或列非数值，按失败返回（假阳性比报错更伤可信度）
      if (checkedRows === 0) {
        return {
          success: false as const,
          error: `列 "${p.column}" 或 "${p.varColumn}" 不存在或不含数值（0 行参与核对）。请用 read_table 确认列名`,
        };
      }
      const skipNote = skippedRows > 0 ? `；${skippedRows} 行非数值未参与核对` : "";
      return {
        success: true as const,
        data: {
          table: p.table,
          column: p.column,
          expression: p.expression,
          checkedRows,
          skippedRows: skippedRows || undefined,
          thresholdPct: threshold,
          outlierCount: outliers.length,
          outliers: outliers.slice(0, 30),
          verdict:
            outliers.length === 0
              ? `${checkedRows} 行参与核对，全部符合公式${skipNote}`
              : `发现 ${outliers.length} 处偏离（疑似手调/断点）${skipNote}`,
        },
      };
    },
  },
  {
    name: "infer_column_rule",
    description:
      "列规则推断（确定性拟合，逆向分析的起点）：对指定数值列拟合三大曲线族（等差/等比/幂律），返回最优规则——参数、吻合占比 fitPct、可直接使用的表达式——以及偏离规则的断点行（疑似手调）。分析成长/消耗曲线的构成规律先用它；得到规则后把 expression 交给 audit_column 复核，或用 write_table 的 apply_curve 按规则整列重算。",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "目标表名（来自 list_tables）" },
        column: { type: "string", description: "要推断的数值列" },
        thresholdPct: { type: "number", description: "偏离阈值百分比（默认 1），超出即计为断点" },
      },
      required: ["table", "column"],
    },
    access: "read",
    module: "workspace",
    execute: async (params, ctx) => {
      const p = (params ?? {}) as { table?: string; column?: string; thresholdPct?: number };
      if (!p.table || !p.column) {
        return { success: false as const, error: "需要 table/column" };
      }
      if (!tablePath(ctx.workspaceRoot, p.table)) {
        return { success: false as const, error: `非法表名: ${p.table}` };
      }
      const rows = loadTableRows(ctx.workspaceRoot, p.table);
      if (!rows) return { success: false as const, error: `表不存在: ${p.table}，请用 list_tables 确认表名` };
      if (rows.length > 0 && rows.every((row) => row[p.column!] === undefined)) {
        return { success: false as const, error: `列 "${p.column}" 不存在，请用 list_tables 确认列名` };
      }
      const result = inferColumnRule(rows.map((row) => row[p.column!]), {
        thresholdPct: p.thresholdPct,
      });
      if (!result) {
        return {
          success: false as const,
          error: `列 "${p.column}" 有效数值行不足 3（或全非数值），无法推断`,
        };
      }
      const fitPctStr = (fit: RuleFit) => Math.round(fit.fitPct * 100);
      const skipNote = result.skippedRows > 0 ? `；${result.skippedRows} 行非数值未参与拟合` : "";
      const label = result.best ? ruleLabel(result.best) : "";
      return {
        success: true as const,
        data: {
          table: p.table,
          column: p.column,
          validRows: result.validRows,
          skippedRows: result.skippedRows || undefined,
          best: result.best
            ? { ...result.best, expression: ruleExpression(result.best), label }
            : null,
          candidates: result.candidates.map((c) => ({ ...c, label: ruleLabel(c) })),
          outlierCount: result.outliers.length,
          outliers: result.outliers.slice(0, 30),
          verdict: !result.best
            ? `未发现可信的单一规则（分段/查表/手调过多），各族候选吻合度供参考${skipNote}`
            : result.outliers.length === 0
              ? `最优规则 ${label}（吻合 ${fitPctStr(result.best)}%），无断点${skipNote}`
              : `最优规则 ${label}（吻合 ${fitPctStr(result.best)}%），发现 ${result.outliers.length} 处断点（疑似手调/分段）${skipNote}`,
        },
      };
    },
  },
  {
    name: "infer_table_relation",
    description:
      "表内列间派生关系推断（确定性拟合）：判断「B 列 ≈ A 列 × k」的系数关系并标出偏离行（取整容限内免误报），或对整表数值列两两配对、自动发现基准锚点列与各列系数。还原「各装备属性 = 基准 × 装备系数」这类生成结构时用；发现系数后可与系数表（如 read_table 装备划分）对照确认同源性。列内时序规律（随行序怎么走）用 infer_column_rule，本工具管列与列的结构。",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "目标表名（来自 list_tables）" },
        columns: {
          type: "array",
          items: { type: "string" },
          description: "参与列。恰 2 列时输出该对的详细关系；多列为子集两两；缺省为全表数值列自动两两",
        },
        thresholdPct: { type: "number", description: "相对容差百分比（默认 1，与取整容限取大）" },
      },
      required: ["table"],
    },
    access: "read",
    module: "workspace",
    execute: async (params, ctx) => {
      const p = (params ?? {}) as { table?: string; columns?: string[]; thresholdPct?: number };
      if (!p.table) return { success: false as const, error: "需要 table" };
      if (!tablePath(ctx.workspaceRoot, p.table)) {
        return { success: false as const, error: `非法表名: ${p.table}` };
      }
      const rows = loadTableRows(ctx.workspaceRoot, p.table);
      if (!rows) return { success: false as const, error: `表不存在: ${p.table}，请用 list_tables 确认表名` };
      if (rows.length === 0) return { success: false as const, error: `表 "${p.table}" 为空表` };
      const options = { thresholdPct: p.thresholdPct };
      const columnOf = (name: string) => rows.map((row) => row[name]);

      // 单对模式：columns 恰 2 列，输出该对的详细关系
      if (p.columns && p.columns.length === 2) {
        const [aName, bName] = p.columns;
        for (const name of [aName, bName]) {
          if (rows.every((row) => row[name] === undefined)) {
            return { success: false as const, error: `列 "${name}" 不存在，请用 list_tables 确认列名` };
          }
        }
        const rel = inferPairRelation(columnOf(aName), columnOf(bName), options);
        return {
          success: true as const,
          data: {
            table: p.table,
            columns: [aName, bName],
            kind: rel.kind,
            ratio: rel.ratio,
            fitPct: rel.fitPct,
            validRows: rel.validRows,
            skippedRows: rel.skippedRows || undefined,
            outlierCount: rel.outliers.length,
            outliers: rel.outliers.slice(0, 30),
            verdict: rel.kind === "none" ? `未发现系数关系：${rel.evidence}` : rel.evidence,
          },
        };
      }

      // 全表/子集模式：数值列两两 + 基准锚点发现
      const allColumns = p.columns ?? Object.keys(rows[0]);
      for (const name of allColumns) {
        if (rows.every((row) => row[name] === undefined)) {
          return { success: false as const, error: `列 "${name}" 不存在，请用 list_tables 确认列名` };
        }
      }
      const columnsMap: Record<string, unknown[]> = {};
      for (const name of allColumns) columnsMap[name] = columnOf(name);
      const result = inferTableRelations(columnsMap, options);
      const relationCount = result.pairs.length;
      return {
        success: true as const,
        data: {
          table: p.table,
          baseColumn: result.baseColumn,
          columns: result.columns,
          pairCount: relationCount,
          pairs: result.pairs
            .slice(0, 30)
            .map(({ a, b, relation }) => ({ a, b, kind: relation.kind, ratio: relation.ratio, fitPct: relation.fitPct, evidence: relation.evidence })),
          excludedColumns: result.excludedColumns.length > 0 ? result.excludedColumns : undefined,
          verdict:
            relationCount === 0
              ? `数值列间未发现系数关系${result.excludedColumns.some((e) => e.reason.includes("上限")) ? "（配对数超上限，请指定 columns 子集）" : ""}`
              : `发现 ${relationCount} 对系数关系，基准锚点「${result.baseColumn}」（其余成立对见 pairs）`,
        },
      };
    },
  },
];
