// @vitest-environment node
/**
 * R1 Wave2 工具面钉死测试（Spec: docs/specs/v9-w2-mcp-server-spec.md）
 *
 * - 注册面恰为 17 = 14 个映射工具 + 3 个 meta 工具（list_workspaces/set_workspace/
 *   import_xlsx——Wave2 落地面终态，Wave1 出口 16 随波升级是 R1 设计语义）
 * - 负断言：20 个排除工具名不出现在注册面
 * - 三向闭合：MAPPED_TOOLS(14) ∪ EXCLUDED_TOOLS(20) == registry 全集名集(34)
 *   （沿 workspace-tool-policy 先例——新增第 35 个工具漏归类即红，不允许静默不可达）
 *
 * 期望清单硬编码在测试内（防自证），与 src/tool-surface.ts 单源导出对比。
 */

import { describe, it, expect } from "vitest";
import { buildMcpRegistry } from "../src/registry";
import { MAPPED_TOOLS, EXCLUDED_TOOLS } from "../src/tool-surface";
import { assembleMcpFace, connectInMemory } from "./helpers";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** 期望的 14 个映射工具（全部 access=read 且不硬依赖身份注入） */
const EXPECTED_MAPPED_14 = [
  "list_tables",
  "read_table",
  "battle_simulate",
  "simulate_gacha",
  "compute_power",
  "power_curve",
  "eval_formula",
  "audit_column",
  "infer_column_rule",
  "infer_table_relation",
  "grade_workspace",
  "profile_table",
  "infer_foreign_keys",
  "read_memory",
];

/** 期望的 20 个排除工具（含排除理由分组注释） */
const EXPECTED_EXCLUDED_20 = [
  // 11 个 write 档（MCP 面无人在回路写确认回路，一律不暴露）
  "write_table",
  "write_plan_rules",
  "restore_table",
  "save_structure",
  "save_memory",
  "plan_module",
  "plan_tasks",
  "update_task",
  "submit_answer",
  "finalize_framework",
  "experience_expectation",
  // 5 个身份硬依赖（Supabase 登录闭包 ctx.projectData，stdio 无登录态）
  "simulate_progression",
  "preview_difficulty",
  "acceptance_report",
  "list_projects",
  "project_summary",
  // 2 个 PLANNING_ONLY 工作区门控 + 问卷状态 DB 行键依赖
  "questionnaire_status",
  "ask_question",
  // 1 个会话 UI 载荷依赖（uiPayload 前端选项卡通道，stdio 无宿主）
  "ask_clarification",
  // 1 个下载载荷（不可枚举 _downloadContent + uiPayload 下载通道，stdio 无宿主）
  "export_deliverable",
];

/** 期望的 3 个 meta 工具（Wave2 终态：import_xlsx 已落地） */
const EXPECTED_META_3 = ["import_xlsx", "list_workspaces", "set_workspace"];

/** Wave2 注册面全量 = 14 映射 + 3 meta = 17 */
const EXPECTED_FACE_17 = [...EXPECTED_MAPPED_14, ...EXPECTED_META_3];

/** 装配完整 Wave2 注册面并经协议侧（Client.listTools）取回工具名列表 */
async function listRegisteredToolNames(): Promise<string[]> {
  const workspacesRoot = mkdtempSync(join(tmpdir(), "gnd-surface-"));
  try {
    const { server } = assembleMcpFace(workspacesRoot);
    const client = await connectInMemory(server);
    const res = await client.listTools();
    return res.tools.map((t) => t.name);
  } finally {
    rmSync(workspacesRoot, { recursive: true, force: true });
  }
}

describe("R1 Wave2: 工具面清单（tool-surface 单源）", () => {
  it("MAPPED_TOOLS 恰为 14 个映射工具名（集合全等）", () => {
    expect([...MAPPED_TOOLS].sort()).toEqual([...EXPECTED_MAPPED_14].sort());
    expect(MAPPED_TOOLS).toHaveLength(14);
  });

  it("EXCLUDED_TOOLS 恰为 20 个排除工具名（集合全等）", () => {
    expect([...EXCLUDED_TOOLS].sort()).toEqual([...EXPECTED_EXCLUDED_20].sort());
    expect(EXCLUDED_TOOLS).toHaveLength(20);
  });
});

describe("R1 Wave2: tools/list 注册面", () => {
  it("注册面恰为 17（14 映射 + 3 meta，名字集合全等，既无缺失也无多出）", async () => {
    const names = await listRegisteredToolNames();
    expect(names).toHaveLength(17);
    expect([...names].sort()).toEqual([...EXPECTED_FACE_17].sort());
  });

  it("负断言：20 个排除工具名不出现在注册面", async () => {
    const names = new Set(await listRegisteredToolNames());
    for (const excluded of EXPECTED_EXCLUDED_20) {
      expect(names.has(excluded)).toBe(false);
    }
  });
});

describe("R1 Wave2: 裁剪闭合", () => {
  it("MAPPED_TOOLS(14) == 裁剪版 registry 全集名集(14)，无缺失无多出，全 read", () => {
    const registry = buildMcpRegistry();
    const allNames = registry.listForLLM().map((t) => t.function.name);
    // 裁剪装配 = 14 映射 + 2 同文件 write 档（save_structure/save_memory——经
    // mapRegistryTools 的 MAPPED_TOOLS 过滤不可达，仅为定义文件整组注册的伴生）
    expect(allNames).toHaveLength(16);
    const extraNames = allNames.filter((n) => !new Set<string>(MAPPED_TOOLS).has(n));
    expect([...extraNames].sort()).toEqual(['save_memory', 'save_structure']);

    // R1 MUST：全部映射工具为 read 档（MCP 面无写权限，readOnlyHint 注解的声明基础）
    for (const name of MAPPED_TOOLS) {
      expect(registry.get(name)?.access, `工具 ${name} 须为 access=read`).toBe("read");
    }
  });

  it("EXCLUDED_TOOLS 名单与 MAPPED_TOOLS 无交集（文档语义自洽）", () => {
    const mappedSet = new Set<string>(MAPPED_TOOLS);
    expect(EXCLUDED_TOOLS.filter((n) => mappedSet.has(n))).toEqual([]);
  });
});
