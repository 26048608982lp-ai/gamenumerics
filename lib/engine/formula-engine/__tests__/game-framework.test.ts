import { describe, it, expect } from "vitest";
import { computeGameFrameworkFromIntent, GENRE_STYLE_CARDS } from "../game-framework";
import type { GameFrameworkDesignIntent } from "../types";
import type { ComputedGameFrameworkData } from "@/lib/types/planning";
import type { GameType } from "@/lib/types/project";
import {
  buildGameFrameworkIntent,
  decisionsFromAnswers,
  applyGameFrameworkDecisions,
  GAME_FRAMEWORK_QUESTION_KEYS,
  GAME_FRAMEWORK_GENRE_DEFAULTS,
} from "../../presets/game-framework-presets";

/**
 * game-framework 引擎 + 预设测试（Spec planning-module-refactor §5 S1）。
 *
 * 注：computeFromIntent 的 "game-framework" 路由归 T3（formula-engine/index.ts，
 * T1 白名单文件，本波不触碰），故此处直调 computeGameFrameworkFromIntent——
 * T3 接线后同参经 computeFromIntent 即得同一产出（路由体内仅原样转发）。
 */

/** 构造测试 intent（decisions 默认值 = 问卷典型组合：RPG 数值成长向） */
function makeIntent(
  overrides?: Partial<GameFrameworkDesignIntent["decisions"]>
): GameFrameworkDesignIntent {
  return {
    moduleType: "game-framework",
    decisions: {
      gameGenre: "rpg",
      corePillar: "数值成长",
      targetPlayer: "碎片化学生党",
      economyGoal: "balanced",
      spendingFocus: "progression",
      resourceAcquisition: "steady",
      progressionPace: "fast_then_slow",
      progressionFeedback: "immediate",
      progressionBreadth: "mixed",
      expectedMaxLevelDays: 90,
      monetizationModel: "内购中度",
      ...overrides,
    },
    strategy: { positioningNotes: "test notes", loopNotes: "test notes" },
  };
}

type AnswerOverrides = Partial<Record<(typeof GAME_FRAMEWORK_QUESTION_KEYS)[number], string | number>>;

/** 构造 11 键问卷答案（存量超集形态——T5 后判定 5 核心键，6 下放键被忽略；expectedMaxLevelDays 用问卷数字串形态） */
function makeAnswers(overrides?: AnswerOverrides): Record<string, string | number> {
  return {
    gameGenre: "rpg",
    corePillar: "数值成长",
    targetPlayer: "碎片化学生党",
    economyGoal: "balanced",
    spendingFocus: "progression",
    resourceAcquisition: "steady",
    progressionPace: "fast_then_slow",
    progressionFeedback: "immediate",
    progressionBreadth: "mixed",
    expectedMaxLevelDays: "90",
    monetizationModel: "内购中度",
    ...overrides,
  };
}

function compute(overrides?: Partial<GameFrameworkDesignIntent["decisions"]>): ComputedGameFrameworkData {
  return computeGameFrameworkFromIntent(makeIntent(overrides));
}

function lineOf(result: ComputedGameFrameworkData, key: string) {
  const line = result.systemBlueprint.suggestedLines.find((l) => l.key === key);
  if (!line) throw new Error(`suggested line ${key} not found`);
  return line;
}

// ==================== S1 契约：模板直算 0 LLM ====================

describe("S1 契约 — 问卷答案模板直算（11 键超集形态，T5 后判定 5 核心键）", () => {
  it("buildGameFrameworkIntent 非 null，5 核心键正确转换（数字串→number），6 下放键=rpg 品类默认", () => {
    const intent = buildGameFrameworkIntent(makeAnswers());
    expect(intent).not.toBeNull();
    // T5：makeAnswers 携带的 6 下放键（immediate/mixed）被忽略，6 键由品类默认填充
    expect(intent!.decisions).toEqual({
      gameGenre: "rpg",
      corePillar: "数值成长",
      targetPlayer: "碎片化学生党",
      economyGoal: "balanced",
      spendingFocus: "progression",
      resourceAcquisition: "steady",
      progressionPace: "fast_then_slow",
      progressionFeedback: "milestone",
      progressionBreadth: "deep_few",
      expectedMaxLevelDays: 90,
      monetizationModel: "内购中度",
    });
  });

  it("computeGameFrameworkFromIntent 产出完整设定卡骨架（moduleType + decisions 11 键回显）", () => {
    const result = compute();
    expect(result.moduleType).toBe("game-framework");
    expect(result.decisions).toEqual(makeIntent().decisions);
    expect(Object.keys(result.decisions)).toHaveLength(11);
  });

  it("systemBlueprint：suggestedLines 非空（5 项）且 hero 恒 enabled", () => {
    const result = compute();
    const lines = result.systemBlueprint.suggestedLines;
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.map((l) => l.key)).toEqual(["hero", "equipment", "skill", "pet", "heroStar"]);
    const hero = lines.find((l) => l.key === "hero")!;
    expect(hero.enabled).toBe(true);
    expect(hero.reason.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(typeof line.enabled).toBe("boolean");
      expect(line.reason.length).toBeGreaterThan(0);
    }
  });

  it("experienceAnchors 三字段就位（回显 + 日投入 + 月付费区间）", () => {
    const result = compute({ expectedMaxLevelDays: 60 });
    expect(result.experienceAnchors.expectedMaxLevelDays).toBe(60);
    expect(result.experienceAnchors.dailyPlayMinutes).toEqual([45, 90]);
    expect(result.experienceAnchors.monthlySpendDepth).toEqual([30, 150]);
  });

  it("moduleRoadmap 恰 6 项且 moduleType 集合完整", () => {
    const result = compute();
    expect(result.moduleRoadmap).toHaveLength(6);
    expect(result.moduleRoadmap.map((m) => m.moduleType)).toEqual([
      "battle",
      "economy",
      "progression",
      "level",
      "monetization",
      "gacha",
    ]);
    for (const entry of result.moduleRoadmap) {
      expect(["high", "medium", "low"]).toContain(entry.priority);
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  it("gameProfile 三字段就位，experienceGoals 2-4 条", () => {
    const result = compute();
    expect(result.gameProfile.positioning.length).toBeGreaterThan(0);
    expect(result.gameProfile.targetPlayerDesc.length).toBeGreaterThan(0);
    expect(result.gameProfile.experienceGoals.length).toBeGreaterThanOrEqual(2);
    expect(result.gameProfile.experienceGoals.length).toBeLessThanOrEqual(4);
  });

  it("coreLoop：summary 非空 + phases 恰 4 环节且命名固定", () => {
    const result = compute();
    expect(result.coreLoop.summary.length).toBeGreaterThan(0);
    expect(result.coreLoop.phases.map((p) => p.name)).toEqual([
      "进入游戏",
      "核心玩法",
      "成长强化",
      "付费或社交",
    ]);
    for (const phase of result.coreLoop.phases) {
      expect(phase.desc.length).toBeGreaterThan(0);
      expect(phase.frequency.length).toBeGreaterThan(0);
    }
  });

  it("build 派生 strategy 文案非空，且与引擎同一套映射表", () => {
    const intent = buildGameFrameworkIntent(makeAnswers())!;
    expect(intent.strategy.positioningNotes.length).toBeGreaterThan(0);
    expect(intent.strategy.loopNotes.length).toBeGreaterThan(0);
    expect(intent.summary!.length).toBeGreaterThan(0);
    const computed = computeGameFrameworkFromIntent(intent);
    expect(intent.strategy.loopNotes).toBe(computed.coreLoop.summary);
    expect(intent.strategy.positioningNotes).toContain(computed.gameProfile.positioning);
    expect(intent.strategy.positioningNotes).toContain(computed.gameProfile.targetPlayerDesc);
    expect(intent.summary).toContain("RPG（角色扮演）");
  });

  it("确定性：相同输入产出相同结果（deep-equal 且非共享引用）", () => {
    const first = computeGameFrameworkFromIntent(makeIntent());
    const second = computeGameFrameworkFromIntent(makeIntent());
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.experienceAnchors.dailyPlayMinutes).not.toBe(second.experienceAnchors.dailyPlayMinutes);
  });

  it("不变异入参 intent", () => {
    const intent = makeIntent();
    const snapshot = JSON.parse(JSON.stringify(intent));
    computeGameFrameworkFromIntent(intent);
    expect(intent).toEqual(snapshot);
  });
});

// ==================== gameProfile 映射 ====================

describe("gameProfile — gameGenre 映射（positioning 拼接维 1 + roadmap）", () => {
  const cases: Array<[GameType, string, "high" | "medium" | "low"]> = [
    ["rpg", "RPG（角色扮演）", "high"],
    ["slg", "SLG（策略）", "medium"],
    ["roguelike", "Roguelike（肉鸽）", "high"],
    ["moba", "MOBA（竞技对抗）", "high"],
    ["card", "卡牌策略", "high"],
    ["casual", "休闲游戏", "low"],
  ];

  it.each(cases)("gameGenre=%s → positioning 含「%s」且 battle priority=%s", (genre, label, battlePriority) => {
    const result = compute({ gameGenre: genre });
    expect(result.gameProfile.positioning).toContain(label);
    expect(result.gameProfile.positioning).toContain("数值成长驱动");
    expect(result.moduleRoadmap.find((m) => m.moduleType === "battle")!.priority).toBe(battlePriority);
  });

  it("positioning = pillar 短语 × genre 品类名两维拼接（精确串）", () => {
    expect(compute().gameProfile.positioning).toBe("一款数值成长驱动的RPG（角色扮演）");
    expect(compute({ gameGenre: "slg", corePillar: "策略对抗" }).gameProfile.positioning).toBe(
      "一款策略对抗驱动的SLG（策略）"
    );
  });
});

describe("gameProfile — corePillar 映射（positioning 维 2 + 核心玩法 + 体验目标）", () => {
  const cases: Array<[GameFrameworkDesignIntent["decisions"]["corePillar"], string, string]> = [
    ["数值成长", "数值成长驱动", "变强"],
    ["策略对抗", "策略对抗驱动", "决策质量"],
    ["操作技巧", "操作技巧驱动", "手感与反应"],
    ["收集养成", "收集养成驱动", "图鉴与收集度"],
  ];

  it.each(cases)("corePillar=%s → positioning/核心玩法/体验目标三块联动", (pillar, phrase, coreKeyword) => {
    const result = compute({ corePillar: pillar });
    expect(result.gameProfile.positioning).toContain(phrase);
    expect(result.coreLoop.phases[1].desc).toContain(coreKeyword);
    expect(result.gameProfile.experienceGoals[0].length).toBeGreaterThan(0);
    expect(result.gameProfile.experienceGoals[1].length).toBeGreaterThan(0);
  });

  it("体验目标前 2 条来自支柱表、后 2 条来自反馈表（默认组合精确断言）", () => {
    const goals = compute().gameProfile.experienceGoals;
    expect(goals).toEqual([
      "每次游玩都能感受到明确的数值提升",
      "养成投入与战力产出保持可感知的正比关系",
      "每次强化/操作即时可见数值反馈",
      "短周期内即可完成一次正反馈循环",
    ]);
  });
});

describe("gameProfile — targetPlayer 映射", () => {
  const cases: Array<[GameFrameworkDesignIntent["decisions"]["targetPlayer"], string, [number, number]]> = [
    ["碎片化学生党", "学生", [45, 90]],
    ["通勤上班族", "上班族", [30, 60]],
    ["核心深度玩家", "深度玩家", [90, 180]],
    ["泛休闲用户", "泛休闲", [15, 40]],
  ];

  it.each(cases)("targetPlayer=%s → 描述含「%s」、日投入=%j、循环会话短语联动", (player, keyword, minutes) => {
    const result = compute({ targetPlayer: player });
    expect(result.gameProfile.targetPlayerDesc).toContain(keyword);
    expect(result.experienceAnchors.dailyPlayMinutes).toEqual(minutes);
    expect(result.experienceAnchors.dailyPlayMinutes[0]).toBeLessThan(result.experienceAnchors.dailyPlayMinutes[1]);
  });
});

describe("gameProfile — progressionFeedback 映射（体验目标贡献维 2）", () => {
  const cases: Array<[GameFrameworkDesignIntent["decisions"]["progressionFeedback"], string, string]> = [
    ["immediate", "即时可见数值反馈", "正反馈循环"],
    ["milestone", "强烈质变体验", "关键节点集中兑现"],
    ["gradual", "细水长流", "安心感"],
  ];

  it.each(cases)("progressionFeedback=%s → 体验目标后 2 条命中", (feedback, goalA, goalB) => {
    const goals = compute({ progressionFeedback: feedback }).gameProfile.experienceGoals;
    expect(goals).toHaveLength(4); // 2（支柱）+ 2（反馈）∈ [2,4]
    expect(goals[2]).toContain(goalA);
    expect(goals[3]).toContain(goalB);
  });
});

// ==================== coreLoop 映射 ====================

describe("coreLoop — progressionPace × targetPlayer 拼接与环节映射", () => {
  const paceCases: Array<[GameFrameworkDesignIntent["decisions"]["progressionPace"], string, string]> = [
    ["fast_then_slow", "前期高速成长", "阶梯式加深"],
    ["steady", "匀速稳定推进", "匀速消耗资源"],
    ["milestone", "里程碑节点集中质变", "集中释放成长跃迁"],
  ];

  it.each(paceCases)("progressionPace=%s → summary 与「成长强化」desc 联动", (pace, summaryPhrase, growthPhrase) => {
    const result = compute({ progressionPace: pace });
    expect(result.coreLoop.summary).toContain(summaryPhrase);
    expect(result.coreLoop.phases[2].desc).toContain(growthPhrase);
  });

  const playerCases: Array<[GameFrameworkDesignIntent["decisions"]["targetPlayer"], string]> = [
    ["碎片化学生党", "碎片时间短会话多次进出"],
    ["通勤上班族", "固定时段稳定会话节奏"],
    ["核心深度玩家", "长会话沉浸式深度投入"],
    ["泛休闲用户", "随开随玩的轻量会话"],
  ];

  it.each(playerCases)("targetPlayer=%s → summary 含会话短语", (player, phrase) => {
    expect(compute({ targetPlayer: player }).coreLoop.summary).toContain(phrase);
  });

  it("summary = pace 短语 + player 短语两维拼接（默认组合精确串）", () => {
    expect(compute().coreLoop.summary).toBe(
      "前期高速成长、后期曲线放缓以拉长寿命，适配碎片时间短会话多次进出"
    );
  });
});

describe("coreLoop — 环节 desc 单维映射", () => {
  const resourceCases: Array<[GameFrameworkDesignIntent["decisions"]["resourceAcquisition"], string]> = [
    ["steady", "稳定日常产出"],
    ["burst", "集中爆发"],
    ["quest_driven", "任务清单"],
  ];

  it.each(resourceCases)("resourceAcquisition=%s → 「进入游戏」desc", (resource, phrase) => {
    expect(compute({ resourceAcquisition: resource }).coreLoop.phases[0].desc).toContain(phrase);
  });

  const spendCases: Array<[GameFrameworkDesignIntent["decisions"]["spendingFocus"], string]> = [
    ["progression", "养成加速"],
    ["gacha", "抽卡"],
    ["social", "公会协作"],
    ["pvp", "竞技排位"],
  ];

  it.each(spendCases)("spendingFocus=%s → 「付费或社交」desc（其余块不受影响）", (focus, phrase) => {
    const base = compute();
    const result = compute({ spendingFocus: focus });
    expect(result.coreLoop.phases[3].desc).toContain(phrase);
    // spendingFocus 不参与建议线判定：systemBlueprint 不变
    expect(result.systemBlueprint).toEqual(base.systemBlueprint);
  });
});

describe("coreLoop — frequency 单维映射（targetPlayer × 4 环节）", () => {
  it.each([
    ["碎片化学生党", "每日 2-3 次（课间/午休碎片档）", "单次 5-10 分钟 × 每日 3-5 次"],
    ["通勤上班族", "每日 2 次（通勤往返）", "单次 15-25 分钟 × 每日 1-2 次"],
    ["核心深度玩家", "每日 1-2 次（固定启动）", "单次 40-60 分钟 × 每日 1-2 次"],
    ["泛休闲用户", "随开随玩、无固定节奏", "单次 3-8 分钟 × 每日 1-3 次"],
  ] as Array<[GameFrameworkDesignIntent["decisions"]["targetPlayer"], string, string]>)(
    "targetPlayer=%s → 4 环节频次全部切换",
    (player, freq0, freq1) => {
      const result = compute({ targetPlayer: player });
      expect(result.coreLoop.phases[0].frequency).toBe(freq0);
      expect(result.coreLoop.phases[1].frequency).toBe(freq1);
      expect(result.coreLoop.phases[2].frequency.length).toBeGreaterThan(0);
      expect(result.coreLoop.phases[3].frequency.length).toBeGreaterThan(0);
    }
  );
});

// ==================== systemBlueprint 映射 ====================

describe("systemBlueprint — 建议线规则表判定", () => {
  it("hero 恒 enabled（任意组合）", () => {
    for (const genre of ["rpg", "slg", "roguelike", "moba", "casual"] as GameType[]) {
      expect(lineOf(compute({ gameGenre: genre }), "hero").enabled).toBe(true);
    }
    expect(lineOf(compute({ corePillar: "收集养成", progressionBreadth: "deep_few" }), "hero").enabled).toBe(true);
  });

  describe("装备线（品类约束 > 支柱/广度信号 > 品类基线 > 兜底）", () => {
    it.each([
      ["rpg+数值成长 → 品类基线开启", { gameGenre: "rpg" } as const, true],
      ["roguelike → build 多样性开启", { gameGenre: "roguelike" } as const, true],
      ["slg+broad_many → 广度信号开启", { gameGenre: "slg", progressionBreadth: "broad_many" } as const, true],
      ["slg+deep_few → 兜底关闭", { gameGenre: "slg", progressionBreadth: "deep_few" } as const, false],
      ["moba+数值成长 → 兜底关闭", { gameGenre: "moba" } as const, false],
      ["casual 品类约束优先于支柱/广度信号 → 关闭", { gameGenre: "casual", corePillar: "收集养成", progressionBreadth: "broad_many" } as const, false],
    ])("%s", (_label, overrides, expected) => {
      expect(lineOf(compute(overrides), "equipment").enabled).toBe(expected);
    });

    it("slg+收集养成 → 支柱信号上翻开启", () => {
      expect(lineOf(compute({ gameGenre: "slg", corePillar: "收集养成" }), "equipment").enabled).toBe(true);
    });
  });

  describe("技能线（moba 品类 > casual/收集约束 > 支柱基线）", () => {
    it.each([
      ["默认 rpg+数值成长 → 开", { gameGenre: "rpg" } as const, true],
      ["moba+收集养成 → moba 信号最强 → 开", { gameGenre: "moba", corePillar: "收集养成" } as const, true],
      ["casual+数值成长 → 品类约束关", { gameGenre: "casual" } as const, false],
      ["rpg+收集养成 → 支柱约束关", { corePillar: "收集养成" } as const, false],
      ["slg+策略对抗 → 开", { gameGenre: "slg", corePillar: "策略对抗" } as const, true],
      ["roguelike+操作技巧 → 开", { gameGenre: "roguelike", corePillar: "操作技巧" } as const, true],
    ])("%s", (_label, overrides, expected) => {
      expect(lineOf(compute(overrides), "skill").enabled).toBe(expected);
    });
  });

  describe("宠物线（支柱信号 > 品类基线）", () => {
    it.each([
      ["rpg → 第二收集轴开启", { gameGenre: "rpg" } as const, true],
      ["casual → 高频轻量标配开启", { gameGenre: "casual" } as const, true],
      ["slg+收集养成 → 支柱信号开启", { gameGenre: "slg", corePillar: "收集养成" } as const, true],
      ["slg+策略对抗 → 关", { gameGenre: "slg", corePillar: "策略对抗" } as const, false],
      ["roguelike → 保 build 纯度关闭", { gameGenre: "roguelike" } as const, false],
      ["moba → 关", { gameGenre: "moba" } as const, false],
    ])("%s", (_label, overrides, expected) => {
      expect(lineOf(compute(overrides), "pet").enabled).toBe(expected);
    });
  });

  describe("升星线（支柱/品类/广度信号 > 品类约束 > rpg 基线）", () => {
    it.each([
      ["rpg+数值成长 → 开", { gameGenre: "rpg" } as const, true],
      ["casual+数值成长 → 支柱信号优先于品类约束 → 开", { gameGenre: "casual" } as const, true],
      ["slg+收集养成 → 品类信号开启", { gameGenre: "slg", corePillar: "收集养成" } as const, true],
      ["roguelike+策略对抗+deep_few → 广度信号开启", { gameGenre: "roguelike", corePillar: "策略对抗", progressionBreadth: "deep_few" } as const, true],
      ["casual+收集养成+mixed → 品类约束关闭", { gameGenre: "casual", corePillar: "收集养成", progressionBreadth: "mixed" } as const, false],
      ["moba+操作技巧 → 关闭", { gameGenre: "moba", corePillar: "操作技巧" } as const, false],
      ["roguelike+收集养成+mixed → 关闭", { gameGenre: "roguelike", corePillar: "收集养成", progressionBreadth: "mixed" } as const, false],
      ["rpg+收集养成+mixed → rpg 基线开启", { corePillar: "收集养成", progressionBreadth: "mixed" } as const, true],
    ])("%s", (_label, overrides, expected) => {
      expect(lineOf(compute(overrides), "heroStar").enabled).toBe(expected);
    });

    it("reason 引用命中的规则依据（开启与关闭均非空）", () => {
      const on = lineOf(compute(), "heroStar");
      const off = lineOf(compute({ gameGenre: "moba", corePillar: "操作技巧" }), "heroStar");
      expect(on.reason).toContain("数值成长支柱");
      expect(off.reason).toContain("MOBA");
    });
  });

  describe("card 档显式规则（T1：插于兜底前，card 不再落 SLG/MOBA 兜底文案）", () => {
    it("card×收集养成 → 装备开（pillar 规则先于 card 品类规则命中）", () => {
      const line = lineOf(
        compute({ gameGenre: "card", corePillar: "收集养成", progressionBreadth: "deep_few" }),
        "equipment"
      );
      expect(line.enabled).toBe(true);
      expect(line.reason).toContain("收集养成支柱");
    });

    it("card×策略对抗（非收集）→ 装备开且 reason 含「卡牌」（card 显式规则）", () => {
      const line = lineOf(
        compute({ gameGenre: "card", corePillar: "策略对抗", progressionBreadth: "mixed" }),
        "equipment"
      );
      expect(line.enabled).toBe(true);
      expect(line.reason).toContain("卡牌");
    });

    it("card → 宠物关且 reason 含「卡牌」", () => {
      const line = lineOf(
        compute({ gameGenre: "card", corePillar: "策略对抗", progressionBreadth: "mixed" }),
        "pet"
      );
      expect(line.enabled).toBe(false);
      expect(line.reason).toContain("卡牌");
    });

    it("card → 升星开且 reason 含「卡牌」", () => {
      const line = lineOf(
        compute({ gameGenre: "card", corePillar: "策略对抗", progressionBreadth: "mixed" }),
        "heroStar"
      );
      expect(line.enabled).toBe(true);
      expect(line.reason).toContain("卡牌");
    });

    it("card 档 GENRE_LABEL 定位含「卡牌策略」", () => {
      expect(compute({ gameGenre: "card" }).gameProfile.positioning).toContain("卡牌策略");
    });
  });
});

describe("systemBlueprint — progressionBreadth 映射（仅影响建议线）", () => {
  it.each([
    ["deep_few → 少线做深：roguelike+收集养成下升星线开启", "deep_few", true],
    ["mixed → 无广度信号：roguelike+收集养成下升星线关闭", "mixed", false],
    ["broad_many → 广养成面：slg+策略对抗下装备线开启", "broad_many", true],
  ] as Array<[string, GameFrameworkDesignIntent["decisions"]["progressionBreadth"], boolean]>)(
    "%s",
    (_label, breadth, expected) => {
      const overrides: Partial<GameFrameworkDesignIntent["decisions"]> = { progressionBreadth: breadth };
      if (breadth === "broad_many") {
        Object.assign(overrides, { gameGenre: "slg", corePillar: "策略对抗" });
        expect(lineOf(compute(overrides), "equipment").enabled).toBe(expected);
      } else {
        Object.assign(overrides, { gameGenre: "roguelike", corePillar: "收集养成" });
        expect(lineOf(compute(overrides), "heroStar").enabled).toBe(expected);
      }
    }
  );
});

// ==================== experienceAnchors 映射 ====================

describe("experienceAnchors — monetizationModel 单维映射", () => {
  it.each([
    ["买断制", [0, 0]],
    ["内购中度", [30, 150]],
    ["内购重度", [300, 2000]],
    ["广告混合", [0, 30]],
  ] as Array<[GameFrameworkDesignIntent["decisions"]["monetizationModel"], [number, number]]>)(
    "monetizationModel=%s → monthlySpendDepth=%j（其余块不变）",
    (model, depth) => {
      const base = compute();
      const result = compute({ monetizationModel: model });
      expect(result.experienceAnchors.monthlySpendDepth).toEqual(depth);
      expect(result.experienceAnchors.monthlySpendDepth[0]).toBeLessThanOrEqual(
        result.experienceAnchors.monthlySpendDepth[1]
      );
      // 商业定位不参与玩法映射：其余块全部不变
      expect(result.gameProfile).toEqual(base.gameProfile);
      expect(result.coreLoop).toEqual(base.coreLoop);
      expect(result.systemBlueprint).toEqual(base.systemBlueprint);
      expect(result.moduleRoadmap).toEqual(base.moduleRoadmap);
      expect(result.experienceAnchors.expectedMaxLevelDays).toBe(base.experienceAnchors.expectedMaxLevelDays);
      expect(result.experienceAnchors.dailyPlayMinutes).toEqual(base.experienceAnchors.dailyPlayMinutes);
    }
  );
});

describe("experienceAnchors — expectedMaxLevelDays 回显", () => {
  it.each([30, 90, 180, 365, 60])("expectedMaxLevelDays=%d 原样回显", (days) => {
    expect(compute({ expectedMaxLevelDays: days }).experienceAnchors.expectedMaxLevelDays).toBe(days);
  });
});

// ==================== moduleRoadmap 映射 ====================

describe("moduleRoadmap — gameGenre 单维映射", () => {
  const genreCases: Array<[GameType, string[]]> = [
    ["rpg", ["battle", "progression", "gacha"]],
    ["slg", ["economy", "monetization"]],
    ["roguelike", ["battle", "level"]],
    ["moba", ["battle", "monetization"]],
    ["card", ["battle", "progression", "monetization", "gacha"]],
    ["casual", ["economy", "monetization"]],
  ];

  it.each(genreCases)("gameGenre=%s → high 集合=%j", (genre, highModules) => {
    const roadmap = compute({ gameGenre: genre }).moduleRoadmap;
    const high = roadmap.filter((m) => m.priority === "high").map((m) => m.moduleType);
    expect(high).toEqual(highModules);
    // 每个 note 均为非空一句话
    for (const m of roadmap) {
      expect(m.note.trim().length).toBeGreaterThan(4);
    }
  });

  it("rpg 下 economy/level/monetization 为 medium、无 low 项", () => {
    const byModule = Object.fromEntries(
      compute({ gameGenre: "rpg" }).moduleRoadmap.map((m) => [m.moduleType, m.priority])
    );
    expect(byModule).toEqual({
      battle: "high",
      economy: "medium",
      progression: "high",
      level: "medium",
      monetization: "medium",
      gacha: "high",
    });
  });

  it("card 档 roadmap 六模块：battle/progression/monetization/gacha 为 high（T1）", () => {
    const byModule = Object.fromEntries(
      compute({ gameGenre: "card" }).moduleRoadmap.map((m) => [m.moduleType, m.priority])
    );
    expect(byModule).toEqual({
      battle: "high",
      economy: "medium",
      progression: "high",
      level: "medium",
      monetization: "high",
      gacha: "high",
    });
    for (const entry of compute({ gameGenre: "card" }).moduleRoadmap) {
      expect(entry.note.trim().length).toBeGreaterThan(4);
    }
  });
});

// ==================== genreStyleCard 派生（Spec genre-style-card R1）====================

describe("genreStyleCard — 品类风格卡静态映射", () => {
  const GENRES: GameType[] = ["rpg", "slg", "roguelike", "moba", "card", "casual"];

  it("静态表六品类完备", () => {
    expect(Object.keys(GENRE_STYLE_CARDS).sort()).toEqual([...GENRES].sort());
  });

  it.each(GENRES)("gameGenre=%s → 七字段全非空且 genre 回显正确", (genre) => {
    const card = compute({ gameGenre: genre }).genreStyleCard;
    expect(card.genre).toBe(genre);
    for (const field of [
      card.positioning,
      card.attributeStyle,
      card.progressionStyle,
      card.levelSemantics,
      card.economyStyle,
      card.powerCurveStyle,
      card.monetizationNote,
    ]) {
      expect(field.trim().length).toBeGreaterThan(4);
    }
  });

  it("computeGameFrameworkFromIntent 产物恒含 genreStyleCard 键且为对应静态卡", () => {
    const result = compute();
    expect(result).toHaveProperty("genreStyleCard");
    expect(result.genreStyleCard).toBe(GENRE_STYLE_CARDS.rpg);
  });

  it("确定性：同输入同输出（静态卡为共享只读引用）", () => {
    const first = computeGameFrameworkFromIntent(makeIntent());
    const second = computeGameFrameworkFromIntent(makeIntent());
    expect(first.genreStyleCard).toEqual(second.genreStyleCard);
    expect(first.genreStyleCard).toBe(second.genreStyleCard);
  });

  it("moba/casual 如实表达数值面较轻（不硬凑养成深度）", () => {
    expect(GENRE_STYLE_CARDS.moba.positioning).toContain("数值面较轻");
    expect(GENRE_STYLE_CARDS.casual.positioning).toContain("数值面较轻");
  });
});

// ==================== 拼接不变量：维度独立性抽样 ====================

describe("拼接不变量 — 任一维度值替换只影响其负责的输出块", () => {
  it("替换 targetPlayer：仅 targetPlayerDesc / coreLoop(summary+frequency) / dailyPlayMinutes 变化", () => {
    const a = compute();
    const b = compute({ targetPlayer: "核心深度玩家" });
    // 负责块变化
    expect(b.gameProfile.targetPlayerDesc).not.toBe(a.gameProfile.targetPlayerDesc);
    expect(b.coreLoop.summary).not.toBe(a.coreLoop.summary);
    expect(b.experienceAnchors.dailyPlayMinutes).not.toBe(a.experienceAnchors.dailyPlayMinutes);
    expect(b.experienceAnchors.dailyPlayMinutes).toEqual([90, 180]);
    // 环节 desc 与频次解耦：desc 全部不变、frequency 全部变化
    expect(b.coreLoop.phases.map((p) => p.desc)).toEqual(a.coreLoop.phases.map((p) => p.desc));
    expect(b.coreLoop.phases.map((p) => p.frequency)).not.toEqual(a.coreLoop.phases.map((p) => p.frequency));
    // 非负责块不变
    expect(b.gameProfile.positioning).toBe(a.gameProfile.positioning);
    expect(b.gameProfile.experienceGoals).toEqual(a.gameProfile.experienceGoals);
    expect(b.systemBlueprint).toEqual(a.systemBlueprint);
    expect(b.moduleRoadmap).toEqual(a.moduleRoadmap);
    expect(b.experienceAnchors.expectedMaxLevelDays).toBe(a.experienceAnchors.expectedMaxLevelDays);
    expect(b.experienceAnchors.monthlySpendDepth).toEqual(a.experienceAnchors.monthlySpendDepth);
  });

  it("替换 progressionPace：仅 coreLoop.summary 与「成长强化」desc 变化", () => {
    const a = compute();
    const b = compute({ progressionPace: "milestone" });
    expect(b.coreLoop.summary).not.toBe(a.coreLoop.summary);
    expect(b.coreLoop.phases[2].desc).not.toBe(a.coreLoop.phases[2].desc);
    // 其余环节的 desc/name/frequency 均不变
    expect(b.coreLoop.phases[0]).toEqual(a.coreLoop.phases[0]);
    expect(b.coreLoop.phases[1]).toEqual(a.coreLoop.phases[1]);
    expect(b.coreLoop.phases[3]).toEqual(a.coreLoop.phases[3]);
    expect(b.coreLoop.phases[2].name).toBe(a.coreLoop.phases[2].name);
    expect(b.coreLoop.phases[2].frequency).toBe(a.coreLoop.phases[2].frequency);
    // 非负责块不变
    expect(b.gameProfile).toEqual(a.gameProfile);
    expect(b.systemBlueprint).toEqual(a.systemBlueprint);
    expect(b.experienceAnchors).toEqual(a.experienceAnchors);
    expect(b.moduleRoadmap).toEqual(a.moduleRoadmap);
  });

  it("替换 gameGenre：仅 positioning / systemBlueprint / moduleRoadmap / genreStyleCard 变化，锚点与玩家侧不变", () => {
    const a = compute();
    const b = compute({ gameGenre: "casual" });
    expect(b.gameProfile.positioning).not.toBe(a.gameProfile.positioning);
    expect(b.systemBlueprint).not.toBe(a.systemBlueprint);
    expect(b.moduleRoadmap).not.toEqual(a.moduleRoadmap);
    expect(b.genreStyleCard).not.toBe(a.genreStyleCard); // R1：gameGenre 负责品类风格卡切换
    // 非负责块不变
    expect(b.gameProfile.targetPlayerDesc).toBe(a.gameProfile.targetPlayerDesc);
    expect(b.gameProfile.experienceGoals).toEqual(a.gameProfile.experienceGoals);
    expect(b.coreLoop).toEqual(a.coreLoop);
    expect(b.experienceAnchors).toEqual(a.experienceAnchors);
  });
});

// ==================== T5 问卷分工重组：5 核心键判定 + 6 键品类默认 ====================

/**
 * module-questionnaire-planning-flow T5（Spec Requirement D「问卷分工重组」）：
 * gf 问卷 15→9 题后，引擎侧判定键 11→5（gameGenre/corePillar/targetPlayer/
 * expectedMaxLevelDays/monetizationModel），下放 6 键（economyGoal/spendingFocus/
 * resourceAcquisition/progressionPace/progressionFeedback/progressionBreadth）
 * 由品类默认表按 gameGenre 填充——decisions 输出保持 11 键全量形态
 * （Correctness F2 裁决：引擎派生与下游消费零波及）。
 */

/** 5 核心键答案（6 下放键缺失——新 UI 9 题问卷的最小命中形态） */
function makeCoreAnswers(overrides?: Record<string, string | number>): Record<string, string | number> {
  return {
    gameGenre: "rpg",
    corePillar: "数值成长",
    targetPlayer: "碎片化学生党",
    expectedMaxLevelDays: "90",
    monetizationModel: "内购中度",
    ...overrides,
  };
}

describe("T5 问卷分工重组 — 5 核心键判定 + 6 键品类默认填充", () => {
  it("GAME_FRAMEWORK_QUESTION_KEYS 缩圈为 5 核心键（6 下放键移出判定集）", () => {
    expect([...GAME_FRAMEWORK_QUESTION_KEYS]).toEqual([
      "gameGenre",
      "corePillar",
      "targetPlayer",
      "expectedMaxLevelDays",
      "monetizationModel",
    ]);
  });

  it("5 核心键齐备（6 下放键缺失）→ decisionsFromAnswers 非 null，decisions 保持 11 键全量形态", () => {
    const decisions = decisionsFromAnswers(makeCoreAnswers());
    expect(decisions).not.toBeNull();
    const coreKeys = Object.keys(decisions!).filter(
      (k) => !["market", "platform", "benchmarkProduct", "differentiation"].includes(k)
    );
    expect(coreKeys).toHaveLength(11);
  });

  it("6 下放键由品类默认表按 gameGenre 填充：rpg 档六键精确断言", () => {
    const decisions = decisionsFromAnswers(makeCoreAnswers())!;
    expect(decisions.economyGoal).toBe("balanced");
    expect(decisions.spendingFocus).toBe("progression");
    expect(decisions.resourceAcquisition).toBe("steady");
    expect(decisions.progressionPace).toBe("fast_then_slow");
    expect(decisions.progressionFeedback).toBe("milestone");
    expect(decisions.progressionBreadth).toBe("deep_few");
  });

  it("buildGameFrameworkIntent 5 键答案直算成功且引擎链路完整（computeGameFrameworkFromIntent）", () => {
    const intent = buildGameFrameworkIntent(makeCoreAnswers());
    expect(intent).not.toBeNull();
    const computed = computeGameFrameworkFromIntent(intent!);
    expect(computed.moduleType).toBe("game-framework");
    expect(computed.decisions).toEqual(intent!.decisions);
    expect(computed.experienceAnchors.expectedMaxLevelDays).toBe(90);
  });

  it("answers 中残留的 6 下放键被忽略（存量超集兼容）：rpg 答案带 immediate/mixed 仍填品类默认", () => {
    const decisions = decisionsFromAnswers(
      makeCoreAnswers({ progressionFeedback: "immediate", progressionBreadth: "mixed", economyGoal: "sink_heavy" })
    )!;
    expect(decisions.progressionFeedback).toBe("milestone");
    expect(decisions.progressionBreadth).toBe("deep_few");
    expect(decisions.economyGoal).toBe("balanced");
  });

  it("品类切换默认联动：slg 档与 rpg 档默认不同（按 gameGenre 取值而非全局常量）", () => {
    const slg = decisionsFromAnswers(makeCoreAnswers({ gameGenre: "slg" }))!;
    const rpg = decisionsFromAnswers(makeCoreAnswers())!;
    expect(slg.economyGoal).toBe("sink_heavy");
    expect(slg.progressionPace).toBe("steady");
    expect(slg.progressionBreadth).toBe("broad_many");
    expect(slg.economyGoal).not.toBe(rpg.economyGoal);
    expect(slg.progressionPace).not.toBe(rpg.progressionPace);
  });

  const GENRES: GameType[] = ["rpg", "slg", "roguelike", "moba", "card", "casual"];
  const DELEGATED_VALUE_DOMAINS: Record<string, readonly string[]> = {
    economyGoal: ["generous", "balanced", "sink_heavy"],
    spendingFocus: ["progression", "gacha", "social", "pvp"],
    resourceAcquisition: ["steady", "burst", "quest_driven"],
    progressionPace: ["fast_then_slow", "steady", "milestone"],
    progressionFeedback: ["immediate", "milestone", "gradual"],
    progressionBreadth: ["deep_few", "broad_many", "mixed"],
  };

  it("品类默认表六品类完备，且每键默认值 ∈ 合法值域（不透传坏数据）", () => {
    expect(Object.keys(GAME_FRAMEWORK_GENRE_DEFAULTS).sort()).toEqual([...GENRES].sort());
    for (const genre of GENRES) {
      const defaults = GAME_FRAMEWORK_GENRE_DEFAULTS[genre];
      for (const [key, domain] of Object.entries(DELEGATED_VALUE_DOMAINS)) {
        expect(domain).toContain(defaults[key as keyof typeof defaults]);
      }
    }
  });

  it.each([
    ["gameGenre", "fps"],
    ["corePillar", "剧情叙事"],
    ["targetPlayer", "硬核土豪"],
    ["expectedMaxLevelDays", "abc"],
    ["expectedMaxLevelDays", 0],
    ["monetizationModel", "订阅制"],
  ] as Array<[string, string | number]>)("5 核心键非法值 %s=%j → null（回退 LLM 路径）", (key, value) => {
    expect(decisionsFromAnswers(makeCoreAnswers({ [key]: value }))).toBeNull();
  });

  it.each([
    "economyGoal",
    "spendingFocus",
    "resourceAcquisition",
    "progressionPace",
    "progressionFeedback",
    "progressionBreadth",
  ])("6 下放键 %s 缺失不阻碍命中（builder 品类默认补全）", (key) => {
    const legacy = { ...makeAnswers() };
    delete legacy[key];
    expect(decisionsFromAnswers(legacy)).not.toBeNull();
  });

  it("6 下放键非法值被忽略仍命中（不再参与判定）", () => {
    expect(
      decisionsFromAnswers(makeCoreAnswers({ progressionPace: "slow", spendingFocus: "装饰外观" }))
    ).not.toBeNull();
  });
});

describe("T5 applyGameFrameworkDecisions — 合并覆写语义（5 键覆写 + 6 键保留/默认补全）", () => {
  it("5 核心键以问卷答案覆写，6 下放键优先保留 intent 已有合法值", () => {
    const llmIntent = makeIntent({
      gameGenre: "slg",
      corePillar: "策略对抗",
      targetPlayer: "核心深度玩家",
      economyGoal: "sink_heavy",
      progressionPace: "milestone",
      progressionBreadth: "broad_many",
      expectedMaxLevelDays: 365,
      monetizationModel: "内购重度",
    });
    const merged = applyGameFrameworkDecisions(llmIntent, makeCoreAnswers());
    // 5 核心键：问卷覆写
    expect(merged.decisions.gameGenre).toBe("rpg");
    expect(merged.decisions.corePillar).toBe("数值成长");
    expect(merged.decisions.targetPlayer).toBe("碎片化学生党");
    expect(merged.decisions.expectedMaxLevelDays).toBe(90);
    expect(merged.decisions.monetizationModel).toBe("内购中度");
    // 6 下放键：保留 intent 已有值（不被品类默认抹掉）
    expect(merged.decisions.economyGoal).toBe("sink_heavy");
    expect(merged.decisions.progressionPace).toBe("milestone");
    expect(merged.decisions.progressionBreadth).toBe("broad_many");
  });

  it("intent 缺 6 下放键（运行时畸形防御）→ 品类默认补全", () => {
    const malformed = makeIntent();
    delete (malformed.decisions as Record<string, unknown>).economyGoal;
    delete (malformed.decisions as Record<string, unknown>).progressionBreadth;
    const merged = applyGameFrameworkDecisions(malformed, makeCoreAnswers());
    expect(merged.decisions.economyGoal).toBe("balanced"); // rpg 品类默认
    expect(merged.decisions.progressionBreadth).toBe("deep_few");
  });

  it("intent 6 下放键为非法值 → 不保留，用品类默认（不透传坏数据）", () => {
    const forged = makeIntent();
    (forged.decisions as Record<string, unknown>).economyGoal = "宽松";
    const merged = applyGameFrameworkDecisions(forged, makeCoreAnswers());
    expect(merged.decisions.economyGoal).toBe("balanced");
  });

  it("问卷 5 核心键缺一 → 保守跳过，返回原 intent 引用", () => {
    const intent = makeIntent();
    const { gameGenre: _omit, ...partial } = makeCoreAnswers();
    void _omit;
    expect(applyGameFrameworkDecisions(intent, partial)).toBe(intent);
  });

  it("问卷 5 核心键非法值 → 保守跳过，返回原 intent 引用", () => {
    const intent = makeIntent();
    expect(applyGameFrameworkDecisions(intent, makeCoreAnswers({ gameGenre: "fps" }))).toBe(intent);
    expect(applyGameFrameworkDecisions(intent, makeCoreAnswers({ expectedMaxLevelDays: "abc" }))).toBe(intent);
  });

  it("纯函数：不变异入参 intent", () => {
    const intent = makeIntent({ gameGenre: "slg" });
    const snapshot = JSON.parse(JSON.stringify(intent));
    applyGameFrameworkDecisions(intent, makeCoreAnswers());
    expect(intent).toEqual(snapshot);
  });
});

// ==================== FU2 覆写 ====================

describe("applyGameFrameworkDecisions — AI 篡改 decisions 的确定性修复", () => {
  it("decisions 全部被 AI 改为其他合法值 → 5 核心键回到问卷值，6 下放键保留 intent 值（T5 合并语义）", () => {
    const tampered = makeIntent({
      gameGenre: "slg",
      corePillar: "策略对抗",
      targetPlayer: "核心深度玩家",
      economyGoal: "sink_heavy",
      spendingFocus: "pvp",
      resourceAcquisition: "burst",
      progressionPace: "milestone",
      progressionFeedback: "gradual",
      progressionBreadth: "broad_many",
      expectedMaxLevelDays: 365,
      monetizationModel: "内购重度",
    });
    const answers = makeAnswers(); // 问卷：rpg / 数值成长 / ... / 90 / 内购中度
    const restored = applyGameFrameworkDecisions(tampered, answers);
    // 5 核心键：问卷覆写
    expect(restored.decisions.gameGenre).toBe("rpg");
    expect(restored.decisions.corePillar).toBe("数值成长");
    expect(restored.decisions.targetPlayer).toBe("碎片化学生党");
    expect(restored.decisions.expectedMaxLevelDays).toBe(90); // 数字串 "90" → 90
    expect(restored.decisions.monetizationModel).toBe("内购中度");
    // 6 下放键：问卷无采集位，保留 intent 已有合法值（LLM 语义不被品类默认抹掉）
    expect(restored.decisions.economyGoal).toBe("sink_heavy");
    expect(restored.decisions.spendingFocus).toBe("pvp");
    expect(restored.decisions.resourceAcquisition).toBe("burst");
    expect(restored.decisions.progressionPace).toBe("milestone");
    expect(restored.decisions.progressionFeedback).toBe("gradual");
    expect(restored.decisions.progressionBreadth).toBe("broad_many");
  });

  it("覆写保留 strategy / summary 等其余字段", () => {
    const intent = { ...makeIntent(), summary: "AI summary" };
    const restored = applyGameFrameworkDecisions(intent, makeAnswers({ gameGenre: "casual" }));
    expect(restored.moduleType).toBe("game-framework");
    expect(restored.strategy).toEqual(intent.strategy);
    expect(restored.summary).toBe("AI summary");
    expect(restored.decisions.gameGenre).toBe("casual");
  });

  it("问卷答案缺任一键 → 保守跳过，返回原 intent 引用", () => {
    const intent = makeIntent();
    const { gameGenre: _omit, ...partial } = makeAnswers();
    void _omit;
    expect(applyGameFrameworkDecisions(intent, partial)).toBe(intent);
  });

  it("问卷答案含非法值 → 保守跳过，返回原 intent 引用", () => {
    const intent = makeIntent();
    expect(applyGameFrameworkDecisions(intent, makeAnswers({ gameGenre: "fps" }))).toBe(intent);
    expect(applyGameFrameworkDecisions(intent, makeAnswers({ monetizationModel: "订阅制" }))).toBe(intent);
    expect(applyGameFrameworkDecisions(intent, makeAnswers({ expectedMaxLevelDays: "abc" }))).toBe(intent);
  });

  it("answers 未提供 → 返回原 intent 引用", () => {
    const intent = makeIntent();
    expect(applyGameFrameworkDecisions(intent)).toBe(intent);
  });

  it("纯函数：不变异入参 intent", () => {
    const intent = makeIntent({ gameGenre: "slg" });
    const snapshot = JSON.parse(JSON.stringify(intent));
    applyGameFrameworkDecisions(intent, makeAnswers());
    expect(intent).toEqual(snapshot);
  });
});

// ==================== buildGameFrameworkIntent 边界 ====================

describe("buildGameFrameworkIntent — 边界与非法输入", () => {
  it.each([...GAME_FRAMEWORK_QUESTION_KEYS])("缺键 %s → null（回退 LLM 路径）", (key) => {
    const { [key]: _omit, ...partial } = makeAnswers();
    void _omit;
    expect(buildGameFrameworkIntent(partial)).toBeNull();
  });

  it.each([
    ["gameGenre", "fps"],
    ["gameGenre", ""],
    ["corePillar", "剧情叙事"],
    ["targetPlayer", "硬核土豪"],
    ["expectedMaxLevelDays", "abc"],
    ["expectedMaxLevelDays", 0],
    ["expectedMaxLevelDays", -5],
    ["monetizationModel", "订阅制"],
  ] as Array<[string, string | number]>)("5 核心键非法值 %s=%j → null（6 下放键非法值被忽略，见 T5 describe）", (key, value) => {
    expect(buildGameFrameworkIntent(makeAnswers({ [key]: value }))).toBeNull();
  });

  it("expectedMaxLevelDays 接受 number 与数字串两种形态", () => {
    expect(buildGameFrameworkIntent(makeAnswers({ expectedMaxLevelDays: "60" }))!.decisions.expectedMaxLevelDays).toBe(60);
    expect(buildGameFrameworkIntent(makeAnswers({ expectedMaxLevelDays: 60 }))!.decisions.expectedMaxLevelDays).toBe(60);
    expect(buildGameFrameworkIntent(makeAnswers({ expectedMaxLevelDays: "365" }))!.decisions.expectedMaxLevelDays).toBe(365);
  });

  it("多余 key 被忽略，仍可直算", () => {
    const answers = { ...makeAnswers(), gameType: "rpg", freeText: "我想要开放世界" };
    expect(buildGameFrameworkIntent(answers)).not.toBeNull();
  });
});

// ==================== 回显保真（decisions 直传键不参与映射）====================

describe("decisions 回显保真 — economyGoal 仅回显不映射", () => {
  it.each([
    ["economyGoal", "generous"],
    ["economyGoal", "sink_heavy"],
  ] as Array<[string, string]>)("%s=%s 原样回显且不影响输出块", (key, value) => {
    const base = compute();
    const result = compute({ [key]: value } as Partial<GameFrameworkDesignIntent["decisions"]>);
    expect(result.decisions[key as keyof GameFrameworkDesignIntent["decisions"]]).toBe(value);
    expect(result.gameProfile).toEqual(base.gameProfile);
    expect(result.coreLoop).toEqual(base.coreLoop);
    expect(result.systemBlueprint).toEqual(base.systemBlueprint);
    expect(result.experienceAnchors).toEqual(base.experienceAnchors);
    expect(result.moduleRoadmap).toEqual(base.moduleRoadmap);
  });
});
