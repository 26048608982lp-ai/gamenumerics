// @vitest-environment node
/**
 * R2 schema 映射 round-trip + R3 映射工具调用执行（Spec: docs/specs/v9-w2-mcp-server-spec.md）
 *
 * R2：映射器是通用能力——buildMcpRegistry() 全量 34 个 ToolDefinition 过映射器，
 *     name/description/parameters 三键域与源定义一致（不经 server，测映射纯函数产物）。
 * R3：映射工具调用经 ToolRegistry.execute 分发；success:false → isError:true；
 *     成功结果同时给 content（text JSON）与 structuredContent；守卫文案 → isError。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpRegistry } from "../src/registry";
import type { ToolRegistry } from "@/lib/agent/tools/protocol";
import { toMcpToolConfig, mapRegistryTools, toMcpResult } from "../src/tool-mapper";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("R2: 裁剪面 16 工具 round-trip（映射纯函数三键域一致）", () => {
  it("16/16 的 name、description 逐字相等且 parameters JSON 深相等（toEqual）", () => {
    const registry = buildMcpRegistry();
    const defs = registry.listForLLM();
    expect(defs).toHaveLength(16);

    for (const def of defs) {
      const tool = registry.get(def.function.name);
      expect(tool, `registry 应含工具 ${def.function.name}`).toBeDefined();
      const config = toMcpToolConfig(tool!);

      // name：注册键与源定义一致
      expect(config.name).toBe(def.function.name);
      // description：逐字相等
      expect(config.description).toBe(def.function.description);
      // parameters：经 fromJsonSchema 包装后 round-trip 深相等
      const roundTripSchema = config.inputSchema["~standard"].jsonSchema.input({
        target: "draft-2020-12",
      });
      expect(roundTripSchema).toEqual(def.function.parameters);
      // 映射面全部 read 档 → readOnlyHint 注解
      expect(config.annotations).toEqual({ readOnlyHint: true });
    }
  });
});

describe("R3: ToolResult → MCP CallToolResult 映射（纯函数）", () => {
  it("success:true → content(text JSON) + structuredContent，无 isError", () => {
    const data = { project: "demo", tableCount: 2 };
    const result = toMcpResult({ success: true, data });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(data) }]);
    expect(result.structuredContent).toEqual(data);
  });

  it("success:false → isError:true + content 含工具层错误文案", () => {
    const result = toMcpResult({ success: false, error: "表不存在: hero，请用 list_tables 确认表名" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "表不存在: hero，请用 list_tables 确认表名" },
    ]);
    expect(result.structuredContent).toBeUndefined();
  });
});

/** fixture 工作区：workspace.json 索引 + tables/*.json 规范化行数据 */
function createFixtureWorkspace(root: string, name: string, tableCount = 2): string {
  const wsRoot = join(root, name);
  mkdirSync(join(wsRoot, "tables"), { recursive: true });
  const tables = Array.from({ length: tableCount }, (_, i) => ({
    table: `table_${i + 1}`,
    module: "gamedata",
    sourceSheet: `sheet_${i + 1}`,
    rows: 2,
    columns: ["id", "value"],
  }));
  writeFileSync(
    join(wsRoot, "workspace.json"),
    JSON.stringify({ project: name, name, tables }),
    "utf-8",
  );
  for (let i = 1; i <= tableCount; i++) {
    writeFileSync(
      join(wsRoot, "tables", `table_${i}.json`),
      JSON.stringify([
        { id: i, value: i * 10 },
        { id: i + 10, value: i * 20 },
      ]),
      "utf-8",
    );
  }
  return wsRoot;
}

describe("R3: 经 McpServer 协议调用（走 registry.execute 分发）", () => {
  let fixtureRoot: string;
  let registry: ToolRegistry;
  let server: McpServer;
  let client: Client;

  beforeAll(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "gnd-mapper-"));
    createFixtureWorkspace(fixtureRoot, "demo-ws", 2);
    registry = buildMcpRegistry();
    server = new McpServer({ name: "mapper-test", version: "0.0.0" });
    mapRegistryTools(server, registry, {
      getContext: () => ({ workspaceRoot: join(fixtureRoot, "demo-ws") }),
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "mapper-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("list_tables 返回真实索引（非 isError，structuredContent 含表数）", async () => {
    const res = await client.callTool({ name: "list_tables", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect((res as { structuredContent?: { tableCount?: number } }).structuredContent
      ?.tableCount).toBe(2);
  });

  it("read_table 不存在的表名 → isError:true 且 content 含工具层错误文案", async () => {
    const res = await client.callTool({ name: "read_table", arguments: { table: "不存在的表" } });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("表不存在");
  });

  it("guard 守卫文案 → isError:true（不进 registry）", async () => {
    const guardServer = new McpServer({ name: "guard-test", version: "0.0.0" });
    mapRegistryTools(guardServer, registry, {
      getContext: () => ({ workspaceRoot: join(fixtureRoot, "demo-ws") }),
      guard: () => "尚未设置当前工作区，请先调 set_workspace",
    });
    const [t1, t2] = InMemoryTransport.createLinkedPair();
    const guardClient = new Client({ name: "guard-test-client", version: "0.0.0" });
    await Promise.all([guardServer.connect(t1), guardClient.connect(t2)]);
    const res = await guardClient.callTool({ name: "list_tables", arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("set_workspace");
  });
});
