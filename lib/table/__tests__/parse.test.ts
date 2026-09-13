import { describe, it, expect } from "vitest";
import { parseSheetMatrix, unpivotColumnPairs } from "../parse";

describe("parseSheetMatrix — 双行表头/星号继承/横向分组", () => {
  it("导表-英雄形状：主表头+子表头合并为 复合键，* 列继承主表头", () => {
    // 形状取自侦察：r1=角色等级|属性(空续)|…|经验消耗，r2=*|攻击|体力|…|单级|累计
    const matrix = [
      ["角色等级", "属性", null, null, "经验消耗", null],
      ["*", "攻击", "体力", null, "单级", "累计"],
      [1, 100, 500, 0.1, 30, null],
      [2, 105, 525, 0.1, 50, 30],
    ];
    const sheet = parseSheetMatrix(matrix, 2);
    expect(sheet.columns).toEqual([
      "角色等级",
      "属性.攻击",
      "属性.体力",
      "属性", // r2 空 → 继承父名「属性」（该列无子表头）
      "经验消耗.单级",
      "经验消耗.累计",
    ]);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]).toEqual({ 角色等级: 1, "属性.攻击": 100, "属性.体力": 500, 属性: 0.1, "经验消耗.单级": 30 });
  });

  it("横向分组：r1 空 = 沿用左侧主表头（属性划分横跨 7 列）", () => {
    const matrix = [
      ["序号", "装备名", "系数", "属性划分", null, null, "辅助"],
      ["*", "*", "*", "攻击", "体力", "均衡", "属性索引"],
      [1, "匕首", 0.666, 0.6, null, null, 1],
    ];
    const sheet = parseSheetMatrix(matrix, 2);
    expect(sheet.columns).toEqual([
      "序号",
      "装备名",
      "系数",
      "属性划分.攻击",
      "属性划分.体力",
      "属性划分.均衡",
      "辅助.属性索引",
    ]);
    expect(sheet.rows[0]["属性划分.攻击"]).toBe(0.6);
  });

  it("重复列名去重：七日签到 物品/数量 并排 → 后缀递增", () => {
    const matrix = [
      ["序号", "1", null, "2", null],
      ["*", "物品", "数量", "物品", "数量"],
      [1, "铜币", 1000, "银子", 100],
    ];
    const sheet = parseSheetMatrix(matrix, 2);
    expect(sheet.columns).toEqual(["序号", "1.物品", "1.数量", "2.物品", "2.数量"]);
    expect(sheet.rows[0]["2.物品"]).toBe("银子");
  });

  it("单行表头（程序导表，如 EnemyLvs）：headerRows=1 直取", () => {
    const matrix = [
      ["hp", "blocking", "damage", "MaxBalance"],
      [300, 10, 5, 10],
      [442, 20, 10, 20],
    ];
    const sheet = parseSheetMatrix(matrix, 1);
    expect(sheet.columns).toEqual(["hp", "blocking", "damage", "MaxBalance"]);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[1].hp).toBe(442);
  });

  it("数值样字符串转 number，非数值文本原样保留", () => {
    const matrix = [["a", "b"], ["123", "名字"], ["0.5", "BalanceAttack"]];
    const sheet = parseSheetMatrix(matrix, 1);
    expect(sheet.rows[0]).toEqual({ a: 123, b: "名字" });
    expect(sheet.rows[1]).toEqual({ a: 0.5, b: "BalanceAttack" });
  });

  it("全空行与全空列被过滤", () => {
    const matrix = [
      ["x", null, "y"],
      [null, null, null],
      [1, null, 2],
    ];
    const sheet = parseSheetMatrix(matrix, 1);
    expect(sheet.columns).toEqual(["x", "y"]);
    expect(sheet.rows).toEqual([{ x: 1, y: 2 }]);
  });

  it("空矩阵返回空表", () => {
    expect(parseSheetMatrix([], 2)).toEqual({ columns: [], rows: [] });
  });
});

describe("unpivotColumnPairs — 并排宽表 tidy 化", () => {
  it("装备强化品质表形状：每行 12 件装备的(属性类型,数值)对展开为长表", () => {
    const rows = [
      { "品质.1": 1, 等级: 1, "升级消耗.材料": 1, "匕首.属性类型": "攻击", "匕首.数值": 20, "大刀.属性类型": "攻击", "大刀.数值": 50 },
      { "品质.1": 1, 等级: 2, "升级消耗.材料": 2, "匕首.属性类型": "攻击", "匕首.数值": 21, "大刀.属性类型": "攻击", "大刀.数值": 53 },
    ];
    const tidy = unpivotColumnPairs(rows, {
      keySuffix: "属性类型",
      valueSuffix: "数值",
      prefixAs: "装备",
      keep: ["品质.1", "等级"],
    });
    expect(tidy).toHaveLength(4);
    expect(tidy[0]).toEqual({ "品质.1": 1, 等级: 1, 装备: "匕首", 属性类型: "攻击", 数值: 20 });
    expect(tidy[3]).toEqual({ "品质.1": 1, 等级: 2, 装备: "大刀", 属性类型: "攻击", 数值: 53 });
  });

  it("某装备该行无值时跳过该配对", () => {
    const rows = [{ 等级: 1, "匕首.属性类型": "攻击", "匕首.数值": 20 }];
    const tidy = unpivotColumnPairs(rows, {
      keySuffix: "属性类型",
      valueSuffix: "数值",
      prefixAs: "装备",
      keep: ["等级"],
    });
    expect(tidy).toEqual([{ 等级: 1, 装备: "匕首", 属性类型: "攻击", 数值: 20 }]);
  });
});
