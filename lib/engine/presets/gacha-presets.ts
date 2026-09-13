import type { GachaDesignIntent } from "../formula-engine/types";

// ==================== 参数档位定义 ====================
// 每道模块题的每个选项映射一组参数档位；三题档位正交组合，全部合法组合均命中。
// 数值锚点对标选项 desc 中的成熟产品，且满足验收区间：
//   目标稀有度期望抽数 ∈ [10, 120]、月免费抽数 ∈ [5, 300]
// （引擎汇率 exchangeRate=10、日免费产出 dailyFreeIncome=100 为硬编码，
//   月免费抽数 = floor(100 × 30 / singleCost)，singleCost 据此设计）。

/** pityIntensity 档位：目标稀有度基础概率 + 保底结构（含 decisions/guarantee 联动） */
interface GachaPityTier {
  /** 目标稀有度基础概率（SSR rate） */
  ssrRate: number;
  guaranteeType: "none" | "pity" | "soft" | "dual";
  hardCount: number;
  softStart?: number;
  softIncrement?: number;
  label: string;
  copy: string;
}

const PITY_TIERS: Record<string, GachaPityTier> = {
  // 原神式：0.6% 基础 + 74 抽起软保底（每抽 +6%）+ 90 抽硬保底 + 大保底
  strict: {
    ssrRate: 0.006,
    guaranteeType: "dual",
    hardCount: 90,
    softStart: 74,
    softIncrement: 0.06,
    label: "严格保底",
    copy: "硬保底必出且有大保底机制（原神式 90 抽硬保底 + 180 抽大保底）",
  },
  // 阴阳师式：高基础概率 + 70 抽起概率渐进提升（每抽 +2%），天井 120 抽
  soft: {
    ssrRate: 0.025,
    guaranteeType: "soft",
    hardCount: 120,
    softStart: 70,
    softIncrement: 0.02,
    label: "柔性保底",
    copy: "概率随抽数渐进上升（阴阳师式，天井 120 抽兑换）",
  },
  // FGO 式：无硬保底，纯概率驱动。hardCount 为名义值（引擎对 type=none
  // 置 hardPity=9999 等效无保底；schema 要求 hardCount ≥ 1 故填名义抽数）
  loose: {
    ssrRate: 0.01,
    guaranteeType: "none",
    hardCount: 300,
    label: "宽松保底",
    copy: "无硬保底，完全依赖基础概率（FGO 式）",
  },
};

/** gachaStyle 档位：卡池稀有度结构、目标稀有度与单抽成本（subTiers.share 为剩余概率的分配比例） */
interface GachaStyleTier {
  poolName: string;
  targetRarity: { id: string; name: string };
  /** 单抽成本（游戏币）：月免费抽数 = floor(3000 / singleCost)，需 ∈ [5, 300] → singleCost ∈ [10, 600] */
  singleCost: number;
  currency: string;
  label: string;
  subTiers: Array<{ id: string; name: string; color: string; share: number }>;
}

const TARGET_RARITY_COLOR = "#ff8000";

const STYLE_TIERS: Record<string, GachaStyleTier> = {
  // 原神/崩铁式：三层角色池，单抽 160（对标 160 原石）
  character_focus: {
    poolName: "角色限定池",
    targetRarity: { id: "ssr_character", name: "传说角色" },
    singleCost: 160,
    currency: "星辉水晶",
    label: "角色为主",
    subTiers: [
      { id: "sr_character", name: "史诗角色", color: "#a335ee", share: 0.08 },
      { id: "r_material", name: "常规素材", color: "#3d8bff", share: 0.92 },
    ],
  },
  // 明日方舟家具池/FGO 礼装式：四层装备池，单抽 150
  weapon_focus: {
    poolName: "专属武器池",
    targetRarity: { id: "ssr_weapon", name: "专属武器" },
    singleCost: 150,
    currency: "锻造晶尘",
    label: "装备为主",
    subTiers: [
      { id: "sr_weapon", name: "稀有武器", color: "#a335ee", share: 0.1 },
      { id: "r_weapon", name: "普通武器", color: "#0070dd", share: 0.25 },
      { id: "n_part", name: "强化零件", color: "#3d8bff", share: 0.65 },
    ],
  },
  // 阴阳师御魂+式神式：三层混合池，单抽 100
  mixed: {
    poolName: "式神装备混合池",
    targetRarity: { id: "ssr_unit", name: "传世核心" },
    singleCost: 100,
    currency: "秘境符咒",
    label: "角色与装备混合",
    subTiers: [
      { id: "sr_unit", name: "精锐核心", color: "#a335ee", share: 0.15 },
      { id: "r_unit", name: "常规单位", color: "#3d8bff", share: 0.85 },
    ],
  },
};

/** rateOpenness 档位：仅影响公示文案（rationale/summary），不影响任何数值 */
const OPENNESS_TIERS: Record<string, { label: string; copy: string }> = {
  transparent: {
    label: "完全透明",
    copy: "公示基础概率与各抽累计概率（原神/崩铁式），玩家可精确规划抽卡预算",
  },
  partial: {
    label: "部分公示",
    copy: "仅公示基础概率，不展示累计概率曲线（多数国产抽卡惯例）",
  },
  opaque: {
    label: "黑箱机制",
    copy: "概率不对外公示，依赖玩家自测（国内监管环境下已基本绝迹，需注意合规风险）",
  },
};

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// ==================== monetization 派生预填（planning-module-refine R1 / T5a）===================

/** 形状合规 gachaProduct 的解析产物（内部中间形状，非导出契约） */
interface GachaProductDraft {
  poolName: string | undefined;
  currency: string;
  costPerPull: number;
  baseSSRRate: number;
  pity: {
    hardPity: number;
    softPityStart?: number;
    softPityIncrement?: number;
    guaranteedFeatured?: true;
  } | null;
}

/** 有限数值读取：非有限数值一律 undefined（容错读取，坏键按缺失处理） */
function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 解析单条 gachaProduct（运行时宽松形状，权威形状见
 * MonetizationDesignIntent.strategy.gachaProducts）。
 * 形状不符 → null：costPerPull / baseSSRRate 为 Spec 钦定降级条件；
 * currencyType 因 schema currency min(1) 硬约束一并校验（缺它则构造产物必不合法）。
 * pity 宽松解析：hardPity 非正整数视为 pity 缺失（降级为无保底，不整产品作废）。
 */
function parseGachaProduct(record: Record<string, unknown>): GachaProductDraft | null {
  const costPerPull = asFiniteNumber(record.costPerPull);
  const baseSSRRate = asFiniteNumber(record.baseSSRRate);
  const currency =
    typeof record.currencyType === "string" && record.currencyType.trim() !== ""
      ? record.currencyType
      : undefined;
  if (
    costPerPull === undefined ||
    costPerPull <= 0 ||
    baseSSRRate === undefined ||
    baseSSRRate <= 0 ||
    baseSSRRate >= 1 ||
    currency === undefined
  ) {
    return null;
  }
  const poolName =
    typeof record.name === "string" && record.name.trim() !== "" ? record.name : undefined;

  let pity: GachaProductDraft["pity"] = null;
  const rawPity = record.pity;
  if (typeof rawPity === "object" && rawPity !== null) {
    const p = rawPity as Record<string, unknown>;
    const hardPity = asFiniteNumber(p.hardPity);
    const softPityStart = asFiniteNumber(p.softPityStart);
    const softPityIncrement = asFiniteNumber(p.softPityIncrement);
    if (hardPity !== undefined && Number.isInteger(hardPity) && hardPity >= 1) {
      pity = {
        hardPity,
        ...(softPityStart !== undefined && Number.isInteger(softPityStart) && softPityStart >= 1
          ? { softPityStart }
          : {}),
        ...(softPityIncrement !== undefined && softPityIncrement > 0 && softPityIncrement <= 1
          ? { softPityIncrement }
          : {}),
        ...(p.guaranteedFeatured === true ? { guaranteedFeatured: true } : {}),
      };
    }
  }

  return { poolName, currency, costPerPull, baseSSRRate, pity };
}

/**
 * 从 monetization confirmed 数据构造 gacha 预填起点 intent（R1 派生预填）。
 *
 * 触发判定（monetization confirmed 且 monetizationModel/primaryModel 双信号）由调用方
 * 负责，本函数只管取数与映射。取数双读：`_strategy.gachaProducts`（intent 回显位）
 * 优先，根级 `gachaProducts` 兜底；取首条形状合规产品（数组前部畸形条目跳过不整体作废）。
 * gachaProducts 缺失/全量形状不符 → null（调用方不预填不报错）。
 *
 * guaranteeType 推导规则（pity 三键 → 四枚举）：
 * - pity 缺失/畸形 → "none"（hardCount 填名义值 9999：引擎对 type=none 置
 *   hardPity=9999 等效无保底，schema 要求 hardCount ≥ 1 故不可省略）
 * - 软保底不在场（softPityStart 缺失 ∨ ≥ hardPity，含相等）→ "pity"（纯硬保底）
 * - softPityStart < hardPity 且 guaranteedFeatured=true → "dual"（硬+软+大保底）
 * - softPityStart < hardPity 且无 guaranteedFeatured → "soft"（硬+软，无大保底）
 *
 * 🔴 softPityStart === hardPity 时必须省略 softStart：该口径表示无软保底，直接映射
 * 会触发 gacha-schema superRefine 的 softStart < hardCount 守卫失败（T1 移交约束）；
 * 引擎兜底 softStart ?? hardCount 同语义，省略后行为不变。softPityStart > hardPity
 * 为退化口径（软保底晚于硬保底，渐进区间为空），按无软保底处理。
 */
export function buildGachaIntentFromMonetization(
  monetizationConfirmed: Record<string, unknown>,
): GachaDesignIntent | null {
  // 双读取数：_strategy 位是数组则以之为准（?? 位置兜底，非逐条兜底——位在数据在）
  const strategy = monetizationConfirmed._strategy;
  const strategyProducts =
    typeof strategy === "object" &&
    strategy !== null &&
    Array.isArray((strategy as Record<string, unknown>).gachaProducts)
      ? ((strategy as Record<string, unknown>).gachaProducts as unknown[])
      : null;
  const rootProducts = Array.isArray(monetizationConfirmed.gachaProducts)
    ? (monetizationConfirmed.gachaProducts as unknown[])
    : null;
  const products = strategyProducts ?? rootProducts;
  if (products === null || products.length === 0) return null;

  const product = products
    .map((raw) =>
      typeof raw === "object" && raw !== null
        ? parseGachaProduct(raw as Record<string, unknown>)
        : null,
    )
    .find((draft): draft is GachaProductDraft => draft !== null);
  // find 无匹配返回 undefined（类型谓词不排除 undefined），两类空值一并拦截
  if (!product) return null;

  const { pity } = product;
  const softStart = pity?.softPityStart;
  // 软保底在场判定：softPityStart < hardPity 才存在渐进区间
  const hasSoft = pity !== null && softStart !== undefined && softStart < pity.hardPity;
  const guaranteeType: GachaDesignIntent["decisions"]["guaranteeType"] =
    pity === null
      ? "none"
      : hasSoft
        ? pity.guaranteedFeatured === true
          ? "dual"
          : "soft"
        : "pity";

  const ssrPct = `${round4(product.baseSSRRate * 100)}%`;
  const pityText =
    pity === null
      ? "无保底机制"
      : hasSoft
        ? `${softStart} 抽起概率渐进（每抽 +${round4((pity.softPityIncrement ?? 0.06) * 100)}%），${pity.hardPity} 抽硬保底${guaranteeType === "dual" ? "并附带大保底" : ""}`
        : `${pity.hardPity} 抽硬保底`;
  const poolLabel = product.poolName ?? "卡池";

  return {
    moduleType: "gacha",
    decisions: {
      guaranteeType,
      targetRarity: "ssr",
      rationale: `从商业化 gachaProducts 预算引用预填：${poolLabel}单抽 ${product.costPerPull} ${product.currency}，SSR 基础概率 ${ssrPct}，${pityText}。`,
    },
    strategy: {
      poolDesign: {
        ...(product.poolName !== undefined ? { name: product.poolName } : {}),
        // 稀有度两档：SSR = baseSSRRate，R 档兜底 1 - rate（率和恒 1，满足 schema 率和
        // 守卫）；不虚构中间档概率——SR 档数值在 gachaProducts 中不存在，预填不造数
        rarities: [
          { id: "ssr", name: "SSR", color: TARGET_RARITY_COLOR, rate: product.baseSSRRate },
          { id: "r", name: "R", color: "#3d8bff", rate: round4(1 - product.baseSSRRate) },
        ],
      },
      guarantee: {
        type: guaranteeType,
        targetRarity: "ssr",
        hardCount: pity === null ? 9999 : pity.hardPity,
        ...(hasSoft && softStart !== undefined
          ? {
              softStart,
              ...(pity?.softPityIncrement !== undefined
                ? { softIncrement: pity.softPityIncrement }
                : {}),
            }
          : {}),
      },
      // tenCost 显式 = singleCost × 10：monetization 预算口径对齐（gachaProducts 无十连价
      // 字段，取无折扣）；不补则引擎缺省派生 9 折，与 demo seed 显式 tenCost（180×10=1800）漂移
      cost: {
        singleCost: product.costPerPull,
        tenCost: product.costPerPull * 10,
        currency: product.currency,
      },
    },
    summary: `${poolLabel}：SSR 基础概率 ${ssrPct}，${pityText}，单抽 ${product.costPerPull} ${product.currency}。`,
  };
}

// ==================== intent 构建（纯函数）===================

/**
 * 构建 gacha 预设 intent。
 * 入参为按题目顺序的问卷值（gachaStyle / pityIntensity / rateOpenness），
 * 调用前已由 resolveTemplateIntent 校验值 ∈ 预设 options。
 */
export function buildGachaIntent(
  gachaStyle: string,
  pityIntensity: string,
  rateOpenness: string,
): GachaDesignIntent {
  const style = STYLE_TIERS[gachaStyle];
  const pity = PITY_TIERS[pityIntensity];
  const openness = OPENNESS_TIERS[rateOpenness];

  // 稀有度概率：目标稀有度 = 保底档位基础概率；次级稀有度按 share 分配剩余概率；
  // 末档兜底取 1 - 已分配之和，保证概率总和恒为 1.0（满足 schema 率和守卫）
  const rarities: GachaDesignIntent["strategy"]["poolDesign"]["rarities"] = [
    {
      id: style.targetRarity.id,
      name: style.targetRarity.name,
      color: TARGET_RARITY_COLOR,
      rate: pity.ssrRate,
    },
  ];
  let allocated = pity.ssrRate;
  style.subTiers.forEach((tier, index) => {
    const isLast = index === style.subTiers.length - 1;
    const rate = isLast
      ? round4(1 - allocated)
      : round4((1 - pity.ssrRate) * tier.share);
    rarities.push({ id: tier.id, name: tier.name, color: tier.color, rate });
    allocated += rate;
  });

  return {
    moduleType: "gacha",
    decisions: {
      guaranteeType: pity.guaranteeType,
      targetRarity: style.targetRarity.id,
      rationale: `${style.label}卡池搭配${pity.label}机制：${pity.copy}。概率公示策略为${openness.label}——${openness.copy}。`,
    },
    strategy: {
      poolDesign: { name: style.poolName, rarities },
      guarantee: {
        type: pity.guaranteeType,
        targetRarity: style.targetRarity.id,
        hardCount: pity.hardCount,
        ...(pity.softStart !== undefined && pity.softIncrement !== undefined
          ? { softStart: pity.softStart, softIncrement: pity.softIncrement }
          : {}),
      },
      cost: { singleCost: style.singleCost, currency: style.currency },
    },
    summary: `${style.poolName}：${pity.copy}，单抽 ${style.singleCost} ${style.currency}，${openness.label}公示。`,
  };
}
