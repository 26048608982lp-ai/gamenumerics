import type { CurveType } from "./types";

/**
 * 归一化位置到 [0, 1]
 * @param index 当前索引
 * @param total 总点数
 */
export function normalize(index: number, total: number): number {
  return total > 1 ? index / (total - 1) : 0;
}

/**
 * 通用曲线插值
 * 给定 [0,1] 位置的 t，在 startValue 和 endValue 之间插值
 */
export function interpolateCurve(
  t: number,
  type: CurveType,
  startValue: number,
  endValue: number,
  params?: { growthFactor?: number; steepness?: number; midpoint?: number }
): number {
  const clampedT = Math.max(0, Math.min(1, t));

  if (startValue === endValue) return startValue;

  switch (type) {
    case "linear": {
      return startValue + (endValue - startValue) * clampedT;
    }
    case "exponential": {
      // 指数增长：慢起快收，startValue 在 t=0，endValue 在 t=1
      const factor = params?.growthFactor ?? 2.0;
      // 使用归一化指数：f(0)=start, f(1)=end
      const expVal = (Math.pow(factor, clampedT) - 1) / (factor - 1);
      return startValue + (endValue - startValue) * expVal;
    }
    case "sigmoid": {
      const steepness = params?.steepness ?? 6;
      const midpoint = params?.midpoint ?? 0.5;
      // Sigmoid: f(0) ≈ startValue, f(1) ≈ endValue
      const sig = 1 / (1 + Math.exp(-steepness * (clampedT - midpoint)));
      const sig0 = 1 / (1 + Math.exp(-steepness * (0 - midpoint)));
      const sig1 = 1 / (1 + Math.exp(-steepness * (1 - midpoint)));
      const normalized = (sig - sig0) / (sig1 - sig0);
      return startValue + (endValue - startValue) * normalized;
    }
    default:
      return startValue + (endValue - startValue) * clampedT;
  }
}

/**
 * 从锚点插值生成完整数值序列
 * 给定若干关键节点值，在相邻锚点间插值填充
 *
 * @param anchors { 位置(从0开始): 值 }，如 { 0: 100, 49: 5000 }
 * @param type 曲线类型
 * @param totalPoints 总点数
 * @param params 曲线参数
 * @returns 长度为 totalPoints 的数值数组
 */
export function interpolateFromAnchors(
  anchors: Record<number, number>,
  type: CurveType,
  totalPoints: number,
  params?: Record<string, number>
): number[] {
  const positions = Object.keys(anchors)
    .map(Number)
    .sort((a, b) => a - b);

  if (positions.length === 0) return new Array(totalPoints).fill(0);
  if (positions.length === 1) {
    return new Array(totalPoints).fill(anchors[positions[0]]);
  }

  const result: number[] = [];

  for (let i = 0; i < totalPoints; i++) {
    // 找到 i 所在的区间
    const anchorIndex = positions.findIndex((p) => p >= i);
    if (anchorIndex === -1) {
      // 超过最后一个锚点
      result.push(anchors[positions[positions.length - 1]]);
      continue;
    }

    const rightPos = positions[anchorIndex];
    if (rightPos === i) {
      result.push(anchors[rightPos]);
      continue;
    }

    if (anchorIndex === 0) {
      // 在第一个锚点之前
      result.push(anchors[positions[0]]);
      continue;
    }

    const leftPos = positions[anchorIndex - 1];
    const leftVal = anchors[leftPos];
    const rightVal = anchors[rightPos];
    const segmentLength = rightPos - leftPos;
    const segmentT = segmentLength > 0 ? (i - leftPos) / segmentLength : 0;

    result.push(
      interpolateCurve(segmentT, type, leftVal, rightVal, params as never)
    );
  }

  return result;
}

/**
 * 属性成长计算
 * 基于 cross-module-validator.ts 中 PowerCurveChain 的成长模型
 */
export function computeAttributeValue(
  levelRatio: number,
  maxLevel: number,
  growthModel: CurveType,
  params?: { growthFactor?: number; steepness?: number; midpoint?: number }
): number {
  if (maxLevel === 0) return 0;
  const ratio = levelRatio;

  switch (growthModel) {
    case "exponential": {
      const growthFactor = params?.growthFactor ?? 1.5;
      return Math.pow(ratio, growthFactor);
    }
    case "sigmoid": {
      const steepness = params?.steepness ?? 10;
      const midpoint = params?.midpoint ?? 0.5;
      return 1 / (1 + Math.exp(-steepness * (ratio - midpoint)));
    }
    case "linear":
    default:
      return ratio;
  }
}
