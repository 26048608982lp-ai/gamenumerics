// @vitest-environment node
/**
 * R4 原子替换「恢复路径」测试（P2-1 修复钉死：docs/specs/v9-w2-mcp-server-spec.md）
 *
 * 覆盖主测试文件无法注入的失败面：旧目录已改名到 .old- 备份位之后、新装配
 * rename 到目标位失败 → 旧工作区必须原样恢复（rm 先行的旧实现在此窗口期旧删
 * 新弃且不可恢复）。
 *
 * 注入方式：vi.mock("fs") 对 renameSync 包一层条件拦截——仅丢弃「to == 目标位」
 * 的首次调用（备份位改名与恢复改名放行），其余 fs 出口全部透传原实现。
 * 独立成文件：主测试文件的 fs 保持原生，不受 mock 涟漪。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as XLSX from "xlsx";
import type { Client } from "@modelcontextprotocol/client";
import { assembleMcpFace, connectInMemory } from "./helpers";

const renameInjection = vi.hoisted(() => ({ failNextRenameTo: null as string | null }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (
      renameInjection.failNextRenameTo !== null &&
      typeof to === "string" &&
      to === renameInjection.failNextRenameTo
    ) {
      renameInjection.failNextRenameTo = null;
      throw new Error("injected: rename-to-target failed");
    }
    return actual.renameSync(from, to);
  };
  return { ...actual, renameSync };
});

/** 单行表头单 sheet 工作簿（内容够区分 v1/v2 即可） */
function buildWorkbook(marker: string): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["id", "marker"],
    [1, marker],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return wb;
}

describe("R4: 同名覆盖原子替换恢复路径（P2-1）", () => {
  let workspacesRoot: string;
  let fixtureDir: string;
  let client: Client;

  beforeEach(async () => {
    workspacesRoot = mkdtempSync(join(tmpdir(), "gnd-restore-root-"));
    fixtureDir = mkdtempSync(join(tmpdir(), "gnd-restore-fx-"));
    const assembled = assembleMcpFace(workspacesRoot);
    client = await connectInMemory(assembled.server);
  });

  afterEach(() => {
    renameInjection.failNextRenameTo = null;
    rmSync(workspacesRoot, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function callImport(args: Record<string, unknown>) {
    return client.callTool({ name: "import_xlsx", arguments: args });
  }

  function text(res: Awaited<ReturnType<Client["callTool"]>>): string {
    return (res.content as { type: string; text: string }[])[0].text;
  }

  it("新装配 rename 失败 → isError 且旧工作区原样恢复（无 .old-/.tmp- 残留）", async () => {
    // v1 导入成功，旧工作区就位
    const v1Path = join(fixtureDir, "v1.xlsx");
    XLSX.writeFile(buildWorkbook("v1-marker"), v1Path);
    const ok = await callImport({ xlsxPath: v1Path, workspaceName: "hero-ws" });
    expect(ok.isError).toBeFalsy();

    // 注入：下一次 rename 到目标位（旧目录已进备份位之后的那次）失败
    const targetDir = join(workspacesRoot, "hero-ws");
    renameInjection.failNextRenameTo = targetDir;

    const v2Path = join(fixtureDir, "v2.xlsx");
    XLSX.writeFile(buildWorkbook("v2-marker"), v2Path);
    const res = await callImport({ xlsxPath: v2Path, workspaceName: "hero-ws" });

    // 诚实报错（文案含旧工作区未受影响的承诺——两步 rename 下为真）
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("未受影响");

    // 旧工作区原样恢复：索引仍是 v1 表
    const index = JSON.parse(
      readFileSync(join(targetDir, "workspace.json"), "utf-8"),
    ) as { tables: { table: string }[] };
    expect(index.tables[0].table).toBe("import/Sheet1");
    const rows = JSON.parse(
      readFileSync(join(targetDir, "tables", "import", "Sheet1.json"), "utf-8"),
    ) as { marker: string }[];
    expect(rows[0]?.marker).toBe("v1-marker");

    // 无临时目录/备份位残留
    const residue = readdirSync(workspacesRoot).filter(
      (n) => n.startsWith(".tmp-") || n.startsWith(".old-"),
    );
    expect(residue).toEqual([]);
  });

  it("未注入失败时 mock 透传不改变行为（对照组：重导入正常替换）", async () => {
    const v1Path = join(fixtureDir, "v1.xlsx");
    XLSX.writeFile(buildWorkbook("v1-marker"), v1Path);
    await callImport({ xlsxPath: v1Path, workspaceName: "hero-ws" });

    const v2Path = join(fixtureDir, "v2.xlsx");
    XLSX.writeFile(buildWorkbook("v2-marker"), v2Path);
    const res = await callImport({ xlsxPath: v2Path, workspaceName: "hero-ws" });
    expect(res.isError).toBeFalsy();

    const rows = JSON.parse(
      readFileSync(join(workspacesRoot, "hero-ws", "tables", "import", "Sheet1.json"), "utf-8"),
    ) as { marker: string }[];
    expect(rows[0]?.marker).toBe("v2-marker");
  });
});
