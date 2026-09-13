// @vitest-environment node
/**
 * R4 xlsx 直读装配测试（Spec: docs/specs/v9-w2-mcp-server-spec.md）
 *
 * - 合法 xlsx 全链路：装配 tables/*.json + workspace.json → 自动 setWorkspace →
 *   list_tables 可见 → read_table 读回行数据（双行表头合并「父.子」复合列名）
 * - headerRows 启发式（detectHeaderRows 独立单测 + 导入摘要回显）：双行 → 2 / 单行 → 1；
 *   sheets[].headerRows 显式指定时优先
 * - 坏输入诚实拒绝：路径不存在 / 非 .xlsx 后缀 / 损坏文件（PK 魔数垃圾字节）/
 *   缺参 / sheets 引用不存在 sheet——全部 isError 可行动文案，不产半成品
 * - 同名覆盖原子性：装配失败（临时目录阶段）清理临时目录且旧工作区完好；
 *   成功重导入整体替换（旧表消失，replaced 标注）
 * - 派生工作区名 sanitize：文件名 stem 非法（空格）→ isError 提示显式 workspaceName；
 *   显式恶意名（路径穿越）同样拒绝
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as XLSX from "xlsx";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Client } from "@modelcontextprotocol/client";
import type { McpSessionState } from "../src/session";
import { detectHeaderRows } from "../src/import-xlsx";
import type { ImportSummary } from "../src/import-xlsx";
import { assembleMcpFace, connectInMemory } from "./helpers";

// ---------- fixture 构造（xlsx 库构造工作簿 → 临时文件，模拟用户本地文件） ----------

/** 双行表头工作簿：r1 父表头全非空字符串，r2 子表头含 null（「成长」为单层列） */
function buildDoubleRowWorkbook(sheetName = "HeroGrowth"): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["英雄", "英雄", "成长"],
    ["编号", "名称", null],
    [1, "hero-1", 100],
    [2, "hero-2", 110],
    [3, "hero-3", 121],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return wb;
}

/** 单行表头工作簿：r1 列名，r2 起数据行（含数值 → 启发式应探测为 1） */
function buildSingleRowWorkbook(sheetName = "Heroes"): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["id", "name", "value"],
    [1, "hero-1", 100],
    [2, "hero-2", 200],
    [3, "hero-3", 400],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return wb;
}

function writeWorkbookTo(wb: XLSX.WorkBook, dir: string, filename: string): string {
  const path = join(dir, filename);
  XLSX.writeFile(wb, path);
  return path;
}

/** 单 sheet 工作簿快捷构造（单行表头 + 指定 sheet 名） */
function writeSingleRowFixture(dir: string, filename: string, sheetName: string): string {
  return writeWorkbookTo(buildSingleRowWorkbook(sheetName), dir, filename);
}

// ---------- 协议调用 helpers ----------

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

function resultText(res: CallResult): string {
  return (res.content as { type: string; text: string }[])[0].text;
}

function structured(res: CallResult): Record<string, unknown> {
  return (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

function importSummary(res: CallResult): ImportSummary {
  return structured(res) as unknown as ImportSummary;
}

// ---------- detectHeaderRows 启发式（独立纯函数单测） ----------

describe("R4: detectHeaderRows 启发式（纯函数）", () => {
  it("双行表头（首行全字符串 + 次行含 null/空）→ 2", () => {
    expect(
      detectHeaderRows([
        ["英雄", "英雄", "成长"],
        ["编号", "名称", null],
        [1, "hero-1", 100],
      ]),
    ).toBe(2);
  });

  it("全复合键双行表头（次行全字符串无空，父.子 形态）→ 2", () => {
    expect(
      detectHeaderRows([
        ["英雄", "英雄"],
        ["编号", "名称"],
      ]),
    ).toBe(2);
  });

  it("单行表头（次行是含数值的数据行）→ 1", () => {
    expect(
      detectHeaderRows([
        ["id", "name", "value"],
        [1, "hero-1", 100],
      ]),
    ).toBe(1);
  });

  it("矩阵不足两行（空/仅表头）→ 1 兜底", () => {
    expect(detectHeaderRows([])).toBe(1);
    expect(detectHeaderRows([["id", "name"]])).toBe(1);
  });
});

// ---------- import_xlsx 全链路（经 InMemoryTransport 协议侧调用） ----------

describe("R4: import_xlsx（协议侧全链路）", () => {
  let workspacesRoot: string;
  let fixtureDir: string;
  let session: McpSessionState;
  let client: Client;

  beforeEach(async () => {
    workspacesRoot = mkdtempSync(join(tmpdir(), "gnd-import-root-"));
    fixtureDir = mkdtempSync(join(tmpdir(), "gnd-import-fx-"));
    const assembled = assembleMcpFace(workspacesRoot);
    session = assembled.session;
    client = await connectInMemory(assembled.server);
  });

  afterEach(() => {
    rmSync(workspacesRoot, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function callImport(args: Record<string, unknown>): Promise<CallResult> {
    return client.callTool({ name: "import_xlsx", arguments: args });
  }

  it("合法双行表头 xlsx：装配落盘 + 自动切换 + list_tables/read_table 全链路", async () => {
    const xlsxPath = writeWorkbookTo(buildDoubleRowWorkbook(), fixtureDir, "HeroGrowth.xlsx");
    const res = await callImport({ xlsxPath });
    expect(res.isError).toBeFalsy();

    const sc = importSummary(res);
    expect(sc.workspace).toBe("HeroGrowth"); // 缺省取文件名 stem
    expect(sc.replaced).toBe(false);
    expect(sc.tableCount).toBe(1);
    const t = sc.tables[0];
    expect(t.sheet).toBe("HeroGrowth");
    expect(t.table).toBe("import/HeroGrowth"); // 缺省 module=import / file=sheet 名
    expect(t.rows).toBe(3);
    expect(t.columns).toEqual(["英雄.编号", "英雄.名称", "成长"]); // 双行表头合并「父.子」
    expect(t.headerRows).toBe(2); // 启发式探测结果随摘要回显（LLM 可据此重试）
    expect(t.columnPatterns?.["英雄.编号"]).toEqual({ type: "arithmetic", first: 1, diff: 1 });

    // 落盘断言：workspace.json 索引 + 规范化表 JSON
    expect(existsSync(join(workspacesRoot, "HeroGrowth", "workspace.json"))).toBe(true);
    expect(
      existsSync(join(workspacesRoot, "HeroGrowth", "tables", "import", "HeroGrowth.json")),
    ).toBe(true);
    const index = JSON.parse(
      readFileSync(join(workspacesRoot, "HeroGrowth", "workspace.json"), "utf-8"),
    ) as { tables: { table: string }[] };
    expect(index.tables[0].table).toBe("import/HeroGrowth");

    // 成功后自动 setWorkspace
    expect(session.currentWorkspace).toBe("HeroGrowth");

    // 后续 list_tables 可见导入表
    const listRes = await client.callTool({ name: "list_tables", arguments: {} });
    expect(listRes.isError).toBeFalsy();
    const lsc = structured(listRes);
    expect(lsc.tableCount).toBe(1);
    expect((lsc.tables as { table: string }[])[0].table).toBe("import/HeroGrowth");

    // read_table 读回行数据
    const readRes = await client.callTool({
      name: "read_table",
      arguments: { table: "import/HeroGrowth" },
    });
    expect(readRes.isError).toBeFalsy();
    const rsc = structured(readRes);
    expect(rsc.totalRows).toBe(3);
    expect((rsc.rows as Record<string, unknown>[])[0]).toEqual({
      "英雄.编号": 1,
      "英雄.名称": "hero-1",
      成长: 100,
    });
  });

  it("多 sheet 工作簿缺省导入全部 sheet（每表独立探测 headerRows）", async () => {
    const wb = buildDoubleRowWorkbook("HeroGrowth");
    const itemsWs = XLSX.utils.aoa_to_sheet([
      ["iid", "price"],
      [1, 10],
      [2, 20],
    ]);
    XLSX.utils.book_append_sheet(wb, itemsWs, "Items");
    const xlsxPath = writeWorkbookTo(wb, fixtureDir, "Multi.xlsx");

    const res = await callImport({ xlsxPath, workspaceName: "multi-ws" });
    expect(res.isError).toBeFalsy();
    const sc = importSummary(res);
    expect(sc.tableCount).toBe(2);
    const bySheet = new Map(sc.tables.map((t) => [t.sheet, t]));
    expect(bySheet.get("HeroGrowth")?.headerRows).toBe(2); // 双行探测
    expect(bySheet.get("Items")?.headerRows).toBe(1); // 单行探测
  });

  it("sheets 子集 + module/file/headerRows 覆盖生效（显式 headerRows 优先于启发式）", async () => {
    const wb = buildDoubleRowWorkbook("HeroGrowth");
    const itemsWs = XLSX.utils.aoa_to_sheet([
      ["iid", "price"],
      [1, 10],
      [2, 20],
    ]);
    XLSX.utils.book_append_sheet(wb, itemsWs, "Items");
    const xlsxPath = writeWorkbookTo(wb, fixtureDir, "Multi.xlsx");

    const res = await callImport({
      xlsxPath,
      workspaceName: "subset-ws",
      sheets: [{ sheet: "Items", module: "economy", file: "items", headerRows: 1 }],
    });
    expect(res.isError).toBeFalsy();
    const sc = importSummary(res);
    expect(sc.tableCount).toBe(1); // 只导入子集
    expect(sc.tables[0].table).toBe("economy/items");
    expect(sc.tables[0].headerRows).toBe(1);
    expect(sc.tables[0].rows).toBe(2);
    expect(
      existsSync(join(workspacesRoot, "subset-ws", "tables", "economy", "items.json")),
    ).toBe(true);
    expect(
      existsSync(join(workspacesRoot, "subset-ws", "tables", "import", "HeroGrowth.json")),
    ).toBe(false); // 未选中的 sheet 不落盘
  });
});

// ---------- 坏输入诚实拒绝（不产半成品） ----------

describe("R4: import_xlsx 坏输入诚实拒绝", () => {
  let workspacesRoot: string;
  let fixtureDir: string;
  let session: McpSessionState;
  let client: Client;

  beforeEach(async () => {
    workspacesRoot = mkdtempSync(join(tmpdir(), "gnd-import-bad-"));
    fixtureDir = mkdtempSync(join(tmpdir(), "gnd-import-badfx-"));
    const assembled = assembleMcpFace(workspacesRoot);
    session = assembled.session;
    client = await connectInMemory(assembled.server);
  });

  afterEach(() => {
    rmSync(workspacesRoot, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function callImport(args: Record<string, unknown>): Promise<CallResult> {
    return client.callTool({ name: "import_xlsx", arguments: args });
  }

  it("路径不存在 → isError 可行动文案（含路径），不切工作区", async () => {
    const missing = join(fixtureDir, "no-such-file.xlsx");
    const res = await callImport({ xlsxPath: missing });
    expect(res.isError).toBe(true);
    const text = resultText(res);
    expect(text).toContain("不存在");
    expect(text).toContain(missing);
    expect(session.currentWorkspace).toBeNull();
  });

  it("UNC/网络路径（// 或 \\\\ 前缀）→ 前置拒绝（网络解析可能阻塞事件循环）", async () => {
    for (const unc of ["//server/share/data.xlsx", "\\\\server\\share\\data.xlsx"]) {
      const res = await callImport({ xlsxPath: unc });
      expect(res.isError, `路径 "${unc}" 应被前置拒绝`).toBe(true);
      expect(resultText(res)).toContain("网络路径");
    }
    expect(session.currentWorkspace).toBeNull();
  });

  it("路径存在但为目录（冒充 .xlsx 文件名）→ isError 文案区分「不是文件」", async () => {
    const dir = join(fixtureDir, "masquerade.xlsx");
    mkdirSync(dir);
    const res = await callImport({ xlsxPath: dir });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("不是文件");
    expect(session.currentWorkspace).toBeNull();
  });

  it("sheets 两项重复指向同一 module/file → isError（防索引重名表静默遮蔽）", async () => {
    const xlsxPath = writeWorkbookTo(buildDoubleRowWorkbook(), fixtureDir, "HeroGrowth.xlsx");
    const res = await callImport({
      xlsxPath,
      workspaceName: "dup-ws",
      sheets: [
        { sheet: "HeroGrowth", module: "gamedata", file: "same" },
        { sheet: "HeroGrowth", module: "gamedata", file: "same" },
      ],
    });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("重复");
    expect(readdirSync(workspacesRoot)).toEqual([]); // 无半成品
  });

  it("非 .xlsx 后缀 → isError（提示另存为 .xlsx）", async () => {
    const p = join(fixtureDir, "data.csv");
    writeFileSync(p, "a,b\n1,2\n", "utf-8");
    const res = await callImport({ xlsxPath: p });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain(".xlsx");
  });

  it("损坏文件（PK 魔数垃圾字节，xlsx 解析抛异常）→ isError，不产半成品", async () => {
    const p = join(fixtureDir, "broken.xlsx");
    writeFileSync(p, Buffer.from("PK\u0003\u0004corrupted-zip-garbage-not-a-real-archive"));
    const res = await callImport({ xlsxPath: p });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("解析失败");
    expect(readdirSync(workspacesRoot)).toEqual([]); // 无半成品工作区/临时目录
  });

  it("缺少 xlsxPath 参数 → isError 可行动文案", async () => {
    const res = await callImport({});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("xlsxPath");
  });

  it("sheets 引用不存在的 sheet 名 → isError 且列出工作簿可用 sheet", async () => {
    const xlsxPath = writeWorkbookTo(buildDoubleRowWorkbook(), fixtureDir, "HeroGrowth.xlsx");
    const res = await callImport({ xlsxPath, sheets: [{ sheet: "NoSuchSheet" }] });
    expect(res.isError).toBe(true);
    const text = resultText(res);
    expect(text).toContain("NoSuchSheet");
    expect(text).toContain("HeroGrowth"); // 可用 sheet 列表提示
  });

  it("sheets[].headerRows 非 1/2 → isError", async () => {
    const xlsxPath = writeWorkbookTo(buildDoubleRowWorkbook(), fixtureDir, "HeroGrowth.xlsx");
    const res = await callImport({ xlsxPath, sheets: [{ sheet: "HeroGrowth", headerRows: 3 }] });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("headerRows");
  });
});

// ---------- 同名覆盖原子性 ----------

describe("R4: import_xlsx 同名覆盖原子性", () => {
  let workspacesRoot: string;
  let fixtureDir: string;
  let client: Client;

  beforeEach(async () => {
    workspacesRoot = mkdtempSync(join(tmpdir(), "gnd-import-atomic-"));
    fixtureDir = mkdtempSync(join(tmpdir(), "gnd-import-atomicfx-"));
    const assembled = assembleMcpFace(workspacesRoot);
    client = await connectInMemory(assembled.server);
  });

  afterEach(() => {
    rmSync(workspacesRoot, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function callImport(args: Record<string, unknown>): Promise<CallResult> {
    return client.callTool({ name: "import_xlsx", arguments: args });
  }

  it("重导入装配失败（临时目录阶段异常）：临时目录清理，旧工作区完好", async () => {
    // v1 导入成功
    const v1 = writeWorkbookTo(buildDoubleRowWorkbook(), fixtureDir, "v1.xlsx");
    const ok = await callImport({ xlsxPath: v1, workspaceName: "hero-ws" });
    expect(ok.isError).toBeFalsy();

    // v2 合法工作簿，但 file 名含非法字符（null 字节）→ 落盘阶段抛异常
    const v2 = writeSingleRowFixture(fixtureDir, "v2.xlsx", "Items");
    const res = await callImport({
      xlsxPath: v2,
      workspaceName: "hero-ws",
      sheets: [{ sheet: "Items", file: "bad\u0000name" }],
    });
    expect(res.isError).toBe(true);

    // 旧工作区完好：v1 索引与表仍在
    const index = JSON.parse(
      readFileSync(join(workspacesRoot, "hero-ws", "workspace.json"), "utf-8"),
    ) as { tables: { table: string }[] };
    expect(index.tables[0].table).toBe("import/HeroGrowth");
    expect(
      existsSync(join(workspacesRoot, "hero-ws", "tables", "import", "HeroGrowth.json")),
    ).toBe(true);
    // 无临时目录残留
    expect(readdirSync(workspacesRoot).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });

  it("成功重导入同名工作区：整体替换（旧表消失，replaced 标注）", async () => {
    const v1 = writeWorkbookTo(buildDoubleRowWorkbook(), fixtureDir, "v1.xlsx");
    await callImport({ xlsxPath: v1, workspaceName: "hero-ws" });

    const v2 = writeSingleRowFixture(fixtureDir, "v2.xlsx", "Items");
    const res = await callImport({ xlsxPath: v2, workspaceName: "hero-ws" });
    expect(res.isError).toBeFalsy();
    expect(importSummary(res).replaced).toBe(true); // 摘要注明重建

    // 旧表被替换：v1 表文件消失，索引只剩 v2 表
    expect(
      existsSync(join(workspacesRoot, "hero-ws", "tables", "import", "HeroGrowth.json")),
    ).toBe(false);
    const listRes = await client.callTool({ name: "list_tables", arguments: {} });
    const lsc = structured(listRes);
    expect(lsc.tableCount).toBe(1);
    expect((lsc.tables as { table: string }[])[0].table).toBe("import/Items");
  });
});

// ---------- 派生工作区名 sanitize（与 set_workspace 同源白名单） ----------

describe("R4: import_xlsx 派生工作区名 sanitize", () => {
  let workspacesRoot: string;
  let fixtureDir: string;
  let session: McpSessionState;
  let client: Client;

  beforeEach(async () => {
    workspacesRoot = mkdtempSync(join(tmpdir(), "gnd-import-sanitize-"));
    fixtureDir = mkdtempSync(join(tmpdir(), "gnd-import-sanfx-"));
    const assembled = assembleMcpFace(workspacesRoot);
    session = assembled.session;
    client = await connectInMemory(assembled.server);
  });

  afterEach(() => {
    rmSync(workspacesRoot, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function callImport(args: Record<string, unknown>): Promise<CallResult> {
    return client.callTool({ name: "import_xlsx", arguments: args });
  }

  it("文件名 stem 非法（含空格）且未传 workspaceName → isError 提示显式指定", async () => {
    const p = writeWorkbookTo(buildDoubleRowWorkbook(), fixtureDir, "bad name.xlsx");
    const res = await callImport({ xlsxPath: p });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("workspaceName");
    expect(session.currentWorkspace).toBeNull();
    expect(readdirSync(workspacesRoot)).toEqual([]);
  });

  it("stem 非法但显式 workspaceName 合法 → 导入成功", async () => {
    const p = writeWorkbookTo(buildDoubleRowWorkbook(), fixtureDir, "bad name.xlsx");
    const res = await callImport({ xlsxPath: p, workspaceName: "hero-ws" });
    expect(res.isError).toBeFalsy();
    expect(importSummary(res).workspace).toBe("hero-ws");
  });

  it("显式恶意 workspaceName（路径穿越）→ isError", async () => {
    const p = writeWorkbookTo(buildDoubleRowWorkbook(), fixtureDir, "ok.xlsx");
    const res = await callImport({ xlsxPath: p, workspaceName: "../evil" });
    expect(res.isError).toBe(true);
    expect(readdirSync(workspacesRoot)).toEqual([]);
  });
});
