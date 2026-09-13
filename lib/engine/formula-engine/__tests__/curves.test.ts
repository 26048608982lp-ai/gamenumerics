import { describe, it, expect } from "vitest";
import { normalize, interpolateCurve, interpolateFromAnchors, computeAttributeValue } from "../curves";

describe("normalize", () => {
  it("returns 0 for single item", () => {
    expect(normalize(0, 1)).toBe(0);
  });

  it("returns 0 for first item", () => {
    expect(normalize(0, 10)).toBe(0);
  });

  it("returns 1 for last item", () => {
    expect(normalize(9, 10)).toBe(1);
  });

  it("returns 0.5 for midpoint", () => {
    expect(normalize(5, 11)).toBeCloseTo(0.5, 10);
  });
});

describe("interpolateCurve", () => {
  describe("linear", () => {
    it("t=0 returns startValue", () => {
      expect(interpolateCurve(0, "linear", 100, 5000)).toBe(100);
    });

    it("t=1 returns endValue", () => {
      expect(interpolateCurve(1, "linear", 100, 5000)).toBe(5000);
    });

    it("t=0.5 returns midpoint", () => {
      expect(interpolateCurve(0.5, "linear", 100, 5000)).toBeCloseTo(2550, 0);
    });
  });

  describe("exponential", () => {
    it("t=0 returns startValue", () => {
      expect(interpolateCurve(0, "exponential", 100, 5000)).toBeCloseTo(100, 5);
    });

    it("t=1 returns endValue", () => {
      expect(interpolateCurve(1, "exponential", 100, 5000)).toBeCloseTo(5000, 0);
    });

    it("midpoint is less than linear midpoint (slow start)", () => {
      const expMid = interpolateCurve(0.5, "exponential", 100, 5000);
      const linMid = interpolateCurve(0.5, "linear", 100, 5000);
      expect(expMid).toBeLessThan(linMid);
    });
  });

  describe("sigmoid", () => {
    it("t=0 ≈ startValue", () => {
      expect(interpolateCurve(0, "sigmoid", 100, 5000)).toBeCloseTo(100, -1);
    });

    it("t=1 ≈ endValue", () => {
      expect(interpolateCurve(1, "sigmoid", 100, 5000)).toBeCloseTo(5000, -1);
    });

    it("steepest change around midpoint", () => {
      const d1 = interpolateCurve(0.51, "sigmoid", 100, 5000) - interpolateCurve(0.49, "sigmoid", 100, 5000);
      const d2 = interpolateCurve(0.11, "sigmoid", 100, 5000) - interpolateCurve(0.09, "sigmoid", 100, 5000);
      expect(d1).toBeGreaterThan(d2);
    });
  });

  describe("edge cases", () => {
    it("clamps t < 0 to startValue", () => {
      expect(interpolateCurve(-1, "linear", 100, 5000)).toBe(100);
    });

    it("clamps t > 1 to endValue", () => {
      expect(interpolateCurve(2, "linear", 100, 5000)).toBe(5000);
    });

    it("returns same value when start === end", () => {
      expect(interpolateCurve(0.5, "linear", 300, 300)).toBe(300);
      expect(interpolateCurve(0.5, "exponential", 300, 300)).toBe(300);
      expect(interpolateCurve(0.5, "sigmoid", 300, 300)).toBe(300);
    });
  });
});

describe("interpolateFromAnchors", () => {
  it("two anchors: first and last match exactly", () => {
    const values = interpolateFromAnchors({ 0: 100, 49: 5000 }, "linear", 50);
    expect(values[0]).toBe(100);
    expect(values[49]).toBe(5000);
    expect(values.length).toBe(50);
  });

  it("three anchors: all three match exactly", () => {
    const values = interpolateFromAnchors({ 0: 100, 24: 800, 49: 5000 }, "linear", 50);
    expect(values[0]).toBe(100);
    expect(values[24]).toBe(800);
    expect(values[49]).toBe(5000);
  });

  it("single anchor: all values equal", () => {
    const values = interpolateFromAnchors({ 10: 500 }, "linear", 50);
    expect(values.every((v) => v === 500)).toBe(true);
  });

  it("empty anchors: returns zeros", () => {
    const values = interpolateFromAnchors({}, "linear", 10);
    expect(values.length).toBe(10);
    expect(values.every((v) => v === 0)).toBe(true);
  });

  it("exponential curve is monotonically increasing", () => {
    const values = interpolateFromAnchors({ 0: 10, 99: 10000 }, "exponential", 100);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
  });

  it("linear midpoint matches expected", () => {
    const values = interpolateFromAnchors({ 0: 0, 10: 100 }, "linear", 11);
    expect(values[5]).toBeCloseTo(50, 5);
  });
});

describe("computeAttributeValue", () => {
  it("linear: returns ratio directly", () => {
    expect(computeAttributeValue(0.5, 50, "linear")).toBeCloseTo(0.5, 5);
  });

  it("exponential: ratio=1 returns 1", () => {
    expect(computeAttributeValue(1, 50, "exponential")).toBeCloseTo(1, 5);
  });

  it("exponential: ratio=0 returns 0", () => {
    expect(computeAttributeValue(0, 50, "exponential")).toBeCloseTo(0, 5);
  });

  it("sigmoid: at midpoint ≈ 0.5", () => {
    const val = computeAttributeValue(0.5, 50, "sigmoid");
    expect(val).toBeCloseTo(0.5, 1);
  });

  it("maxLevel=0 returns 0", () => {
    expect(computeAttributeValue(0.5, 0, "linear")).toBe(0);
  });

  it("exponential with custom growthFactor=2.0", () => {
    const val = computeAttributeValue(0.5, 50, "exponential", { growthFactor: 2.0 });
    expect(val).toBeCloseTo(Math.pow(0.5, 2.0), 10);
  });

  it("exponential with custom growthFactor=1.0 behaves like linear", () => {
    const val = computeAttributeValue(0.5, 50, "exponential", { growthFactor: 1.0 });
    expect(val).toBeCloseTo(0.5, 10);
  });

  it("sigmoid with custom steepness and midpoint", () => {
    const val = computeAttributeValue(0.3, 50, "sigmoid", { steepness: 5, midpoint: 0.3 });
    expect(val).toBeCloseTo(0.5, 1);
  });

  it("sigmoid with custom steepness only", () => {
    const val = computeAttributeValue(0.5, 50, "sigmoid", { steepness: 20 });
    const expected = 1 / (1 + Math.exp(-20 * (0.5 - 0.5)));
    expect(val).toBeCloseTo(expected, 10);
  });

  it("backward compatible: exponential without params equals hardcoded 1.5", () => {
    const withoutParams = computeAttributeValue(0.6, 50, "exponential");
    const withDefaultParams = computeAttributeValue(0.6, 50, "exponential", { growthFactor: 1.5 });
    expect(withoutParams).toBeCloseTo(withDefaultParams, 10);
  });

  it("backward compatible: sigmoid without params equals hardcoded steepness=10 midpoint=0.5", () => {
    const withoutParams = computeAttributeValue(0.7, 50, "sigmoid");
    const withDefaultParams = computeAttributeValue(0.7, 50, "sigmoid", { steepness: 10, midpoint: 0.5 });
    expect(withoutParams).toBeCloseTo(withDefaultParams, 10);
  });

  it("backward compatible: linear ignores params", () => {
    const withoutParams = computeAttributeValue(0.4, 50, "linear");
    const withParams = computeAttributeValue(0.4, 50, "linear", { growthFactor: 3.0, steepness: 20, midpoint: 0.7 });
    expect(withoutParams).toBeCloseTo(withParams, 10);
  });

  // ── Boundary: NaN inputs ──────────────────────────────────────────────
  it("NaN ratio returns NaN for linear", () => {
    expect(Number.isNaN(computeAttributeValue(NaN, 50, "linear"))).toBe(true);
  });

  it("NaN ratio returns NaN for exponential", () => {
    expect(Number.isNaN(computeAttributeValue(NaN, 50, "exponential"))).toBe(true);
  });

  it("NaN ratio returns NaN for sigmoid", () => {
    expect(Number.isNaN(computeAttributeValue(NaN, 50, "sigmoid"))).toBe(true);
  });

  it("NaN growthFactor returns NaN for exponential", () => {
    expect(Number.isNaN(computeAttributeValue(0.5, 50, "exponential", { growthFactor: NaN }))).toBe(true);
  });

  it("NaN steepness returns NaN for sigmoid", () => {
    expect(Number.isNaN(computeAttributeValue(0.5, 50, "sigmoid", { steepness: NaN }))).toBe(true);
  });

  // ── Boundary: negative inputs ─────────────────────────────────────────
  it("negative ratio for linear returns negative value", () => {
    // Note: computeAttributeValue does not clamp ratio
    expect(computeAttributeValue(-0.5, 50, "linear")).toBeCloseTo(-0.5, 10);
  });

  it("negative ratio for exponential returns NaN (pow of negative base)", () => {
    // Math.pow(-0.5, 1.5) = NaN
    expect(Number.isNaN(computeAttributeValue(-0.5, 50, "exponential"))).toBe(true);
  });

  // ── Boundary: zero inputs ─────────────────────────────────────────────
  it("zero ratio for linear returns 0", () => {
    expect(computeAttributeValue(0, 50, "linear")).toBeCloseTo(0, 10);
  });

  it("zero ratio for exponential returns 0", () => {
    expect(computeAttributeValue(0, 50, "exponential")).toBeCloseTo(0, 10);
  });

  it("zero ratio for sigmoid returns very small positive value", () => {
    const val = computeAttributeValue(0, 50, "sigmoid");
    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThan(0.5);
  });

  // ── Boundary: Infinity inputs ─────────────────────────────────────────
  it("Infinity ratio for linear returns Infinity", () => {
    expect(computeAttributeValue(Infinity, 50, "linear")).toBe(Infinity);
  });

  it("Infinity ratio for exponential returns Infinity", () => {
    expect(computeAttributeValue(Infinity, 50, "exponential")).toBe(Infinity);
  });

  it("Infinity steepness for sigmoid at midpoint returns NaN (exp(-Infinity*0)=NaN)", () => {
    const val = computeAttributeValue(0.5, 50, "sigmoid", { steepness: Infinity });
    // Math.exp(-Infinity * 0) = Math.exp(NaN) = NaN
    expect(Number.isNaN(val)).toBe(true);
  });
});
