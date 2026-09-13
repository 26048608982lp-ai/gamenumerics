import { describe, it, expect } from "vitest";
import { evalExpression } from "../expression";

describe("evalExpression — 迷你表达式求值器", () => {
  it("四则与优先级", () => {
    expect(evalExpression("1 + 2 * 3")).toBe(7);
    expect(evalExpression("(1 + 2) * 3")).toBe(9);
    expect(evalExpression("10 / 4")).toBe(2.5);
    expect(evalExpression("100 - 5 * 4")).toBe(80);
  });

  it("幂与右结合、负号", () => {
    expect(evalExpression("2 ^ 10")).toBe(1024);
    expect(evalExpression("2 ^ 3 ^ 2")).toBe(512); // 右结合 = 2^9
    expect(evalExpression("-3 + 5")).toBe(2);
    expect(evalExpression("2 ^ -2")).toBe(0.25);
  });

  it("中文变量与替换（锚点公式形态）", () => {
    expect(evalExpression("100 * 1.05 ^ (等级 - 1)", { 等级: 3 })).toBeCloseTo(110.25, 6);
    expect(evalExpression("基础攻击 * 系数 + 固定值", { 基础攻击: 100, 系数: 0.6, 固定值: 20 })).toBe(80);
  });

  it("错误路径：除零/未知变量/非法字符/括号不闭合/多余内容", () => {
    expect(() => evalExpression("1 / 0")).toThrow("除零");
    expect(() => evalExpression("a + 1")).toThrow("变量未提供");
    expect(() => evalExpression("sum(a1:b2)")).toThrow("不支持的字符");
    expect(() => evalExpression("(1 + 2")).toThrow("不闭合");
    expect(() => evalExpression("1 2")).toThrow("多余内容");
    expect(() => evalExpression("")).toThrow("空");
  });
});
