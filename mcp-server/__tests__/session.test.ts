// @vitest-environment node
/**
 * R5 工作区会话状态测试（Spec: docs/specs/v9-w2-mcp-server-spec.md）
 *
 * - 工作区根解析：GND_WORKSPACES_DIR 优先；缺省 ~/.gamenumerics/workspaces（绝不落仓库 workspaces/）
 * - session 层单点守卫：未设当前工作区时全部 14 个映射工具统一返回引导性 isError
 *   （文案引导先调 import_xlsx 或 set_workspace——import_xlsx 是 Wave2 工具，文案预告它），
 *   绝不以 undefined workspaceRoot 进入 registry
 * - set_workspace：名字 sanitize 白名单防穿越；不存在名返回 isError；合法名切换后 getContext 生效
 * - list_workspaces：列出工作区根下目录
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpRegistry } from "../src/registry";
import { resolveWorkspacesRoot, createSession, registerMetaTools } from "../src/session";
import { mapRegistryTools } from "../src/tool-mapper";
import { MAPPED_TOOLS } from "../src/tool-surface";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";

/** fixture 工作区：workspace.json 索引 + tables/*.json 规范化行数据 */
function createFixtureWorkspace(root: string, name: string, tableCount = 1): string {
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

describe("R5: 工作区根解析（resolveWorkspacesRoot）", () => {
  it("GND_WORKSPACES_DIR 环境变量优先，目录不存在时递归创建", () => {
    const base = mkdtempSync(join(tmpdir(), "gnd-root-env-"));
    try {
      const dir = join(base, "custom-ws");
      expect(existsSync(dir)).toBe(false);
      const root = resolveWorkspacesRoot({ GND_WORKSPACES_DIR: dir });
      expect(root).toBe(dir);
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("缺省 ~/.gamenumerics/workspaces（os.homedir() 拼接，绝不落仓库 workspaces/）", () => {
    const root = resolveWorkspacesRoot({});
    expect(root).toBe(join(homedir(), ".gamenumerics", "workspaces"));
  });

  it("GND_WORKSPACES_DIR 相对值按用户主目录解析（不依赖 process.cwd()）", () => {
    let root: string | null = null;
    try {
      root = resolveWorkspacesRoot({ GND_WORKSPACES_DIR: "gnd-relative-ws-check" });
      expect(root).toBe(join(homedir(), "gnd-relative-ws-check"));
      expect(existsSync(root)).toBe(true);
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("R5: 会话状态与守卫（createSession）", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gnd-session-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("未设工作区：currentWorkspace 为 null，守卫文案含 import_xlsx 与 set_workspace 提示", () => {
    const session = createSession({ workspacesRoot: root });
    expect(session.currentWorkspace).toBeNull();
    const msg = session.guardMissingWorkspace();
    expect(msg).not.toBeNull();
    expect(msg).toContain("import_xlsx");
    expect(msg).toContain("set_workspace");
  });

  it("未设工作区：全部 14 个映射工具统一返回引导性 isError（不以 undefined workspaceRoot 进 registry）", async () => {
    const session = createSession({ workspacesRoot: root });
    const registry = buildMcpRegistry();
    const server = new McpServer({ name: "session-guard-test", version: "0.0.0" });
    mapRegistryTools(server, registry, {
      getContext: () => session.getContext(),
      guard: () => session.guardMissingWorkspace(),
    });
    const [t1, t2] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "session-guard-client", version: "0.0.0" });
    await Promise.all([server.connect(t1), client.connect(t2)]);

    expect(MAPPED_TOOLS).toHaveLength(14);
    for (const name of MAPPED_TOOLS) {
      const res = await client.callTool({ name, arguments: {} });
      expect(res.isError, `工具 ${name} 应返回 isError`).toBe(true);
      const text = (res.content as { type: string; text: string }[])[0].text;
      expect(text).toContain("import_xlsx");
      expect(text).toContain("set_workspace");
    }
  });
});

describe("R5: meta 工具（list_workspaces / set_workspace）", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gnd-meta-"));
    createFixtureWorkspace(root, "alpha-ws", 1);
    createFixtureWorkspace(root, "beta-ws", 1);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function buildConnected() {
    const session = createSession({ workspacesRoot: root });
    const server = new McpServer({ name: "meta-test", version: "0.0.0" });
    mapRegistryTools(server, buildMcpRegistry(), {
      getContext: () => session.getContext(),
      guard: () => session.guardMissingWorkspace(),
    });
    registerMetaTools(server, session);
    return { session, server };
  }

  async function connect(server: McpServer): Promise<Client> {
    const [t1, t2] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "meta-test-client", version: "0.0.0" });
    await Promise.all([server.connect(t1), client.connect(t2)]);
    return client;
  }

  it("list_workspaces 列出 fixture 工作区目录（structuredContent）", async () => {
    const { server } = buildConnected();
    const client = await connect(server);
    const res = await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = (res as { structuredContent?: { workspaces?: string[] } }).structuredContent;
    expect(sc?.workspaces?.sort()).toEqual(["alpha-ws", "beta-ws"]);
  });

  it("set_workspace 不存在的名字 → isError", async () => {
    const { server } = buildConnected();
    const client = await connect(server);
    const res = await client.callTool({ name: "set_workspace", arguments: { name: "no-such-ws" } });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("no-such-ws");
  });

  it("set_workspace 非法名字（路径穿越/非法字符）→ isError，不切换", async () => {
    const { session, server } = buildConnected();
    const client = await connect(server);
    for (const bad of ["../escape", "..\\escape", "a/b", ".hidden", "带空格 名字"]) {
      const res = await client.callTool({ name: "set_workspace", arguments: { name: bad } });
      expect(res.isError, `名字 "${bad}" 应被 sanitize 拒绝`).toBe(true);
    }
    expect(session.currentWorkspace).toBeNull();
  });

  it("合法名切换成功后 getContext().workspaceRoot 指向该工作区", async () => {
    const { session, server } = buildConnected();
    const client = await connect(server);
    const res = await client.callTool({ name: "set_workspace", arguments: { name: "alpha-ws" } });
    expect(res.isError).toBeFalsy();
    expect(session.currentWorkspace).toBe("alpha-ws");
    expect(session.getContext().workspaceRoot).toBe(join(root, "alpha-ws"));
    expect(session.getContext().workspaceRoot).not.toBe(join(root, "beta-ws"));

    // 切换后守卫解除：list_tables 经新工作区返回真实索引
    const listRes = await client.callTool({ name: "list_tables", arguments: {} });
    expect(listRes.isError).toBeFalsy();
    const sc = (listRes as { structuredContent?: { tableCount?: number } }).structuredContent;
    expect(sc?.tableCount).toBe(1);
  });
});
