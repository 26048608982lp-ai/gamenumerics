/**
 * import_xlsx meta 工具（Spec R4：docs/specs/v9-w2-mcp-server-spec.md）
 *
 * 本地 xlsx → 规范化工作区（workspace.json + tables/*.json）装配入口：
 * 复用 scripts/lib/workspace-import.ts 共享骨架（底层 lib/table/parse.ts 双行
 * 表头合并「父.子」复合键 + lib/table/pattern.ts 列模式识别），装配在
 * <workspacesRoot>/.tmp-<name>-<ts> 临时目录进行，全部 sheet 成功且 workspace.json
 * 写完后整体替换目标目录（两步 rename：旧目录先改名到 .old- 备份位，新装配就位后
 * 删备份，中途失败旧工作区原样恢复——同卷 rename 原子），任何失败清理临时目录
 * 返回 isError——旧工作区保持完好。
 *
 * 沙箱不对称（Spec 边界条件）：读取任意本地路径（用户主动提供绝对路径，宿主
 * 契约内的合理能力）；写侧严格限于 GND_WORKSPACES_DIR 根内经 sanitize 的子目录
 * （与 set_workspace 守卫同源白名单，module/file 拒路径分隔符与 .. 防临时目录内逃逸）。
 */

import * as XLSX from "xlsx";
// xlsx 0.20.3 起 esbuild --format=esm 按 exports 解析到 xlsx.mjs（ESM 构建无内置
// fs），readFile/writeFile 需显式注入——W3 换源（0.18.5→0.20.3）后重建 bundle 即
// 触发（SheetJS 官方 ESM 用法）。CJS 构建（根 vitest alias 钉 xlsx.js）下 set_fs
// 同名存在，调用无害。
import * as nodeFs from "node:fs";
XLSX.set_fs(nodeFs);
import { existsSync, renameSync, rmSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
  importSheet,
  sheetToMatrix,
  writeWorkspaceJson,
  type SheetSpec,
  type TableIndexEntry,
} from "@/scripts/lib/workspace-import";
import { sanitizeWorkspaceName } from "./session";
import type { McpSessionState } from "./session";
import { passthroughValidator } from "./tool-mapper";

// ---------- headerRows 启发式（Spec 边界风险 R-W2-c：结果随摘要回显可重试） ----------

function cellText(v: unknown): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

/**
 * headerRows 启发式探测：首行全为非空字符串（表头特征），且次行满足任一
 * 「子表头」特征 → 2：
 *   a) 次行含 null/空单元格（星号继承/单层列——双行表头的典型形状）
 *   b) 次行全部单元格为字符串类型（全「父.子」复合表头——须按原始类型判，
 *      文本化会把数值数据行 1/10 误判为字符串）
 * 其余（首行含空/数值，或次行含数值单元格即数据行）→ 1。矩阵不足两行按 1 兜底。
 * 探测失误风险由导入摘要的 headerRows 回显暴露，LLM 可带显式 headerRows 重试。
 */
export function detectHeaderRows(matrix: unknown[][]): 1 | 2 {
  if (matrix.length < 2) return 1;
  const first = matrix[0] ?? [];
  const second = matrix[1] ?? [];
  const width = Math.max(first.length, second.length);
  if (width === 0) return 1;
  const firstTexts = Array.from({ length: width }, (_, i) => cellText(first[i]));
  if (firstTexts.some((t) => t === "")) return 1; // 首行含空 → 非全满父表头
  const secondTexts = Array.from({ length: width }, (_, i) => cellText(second[i]));
  if (secondTexts.some((t) => t === "")) return 2; // a) null/空单元格
  // b) 次行全部单元格为字符串类型（数值单元格 → 数据行 → 1）
  const allStringCells = Array.from({ length: width }, (_, i) => second[i]).every(
    (v) => typeof v === "string",
  );
  return allStringCells ? 2 : 1;
}

// ---------- 导入摘要类型（structuredContent 双通道的契约） ----------

/** 每表摘要：sheet 名 + 行列 + headerRows 回显 + 列模式（启发式失误可据此重试） */
export interface ImportTableSummary {
  sheet: string;
  table: string;
  module: string;
  rows: number;
  columns: string[];
  headerRows: 1 | 2;
  columnPatterns: TableIndexEntry["columnPatterns"];
}

export interface ImportSummary {
  workspace: string;
  workspaceRoot: string;
  /** 同名工作区覆盖重建标注（旧目录已被整体替换） */
  replaced: boolean;
  tableCount: number;
  tables: ImportTableSummary[];
}

// ---------- meta 工具纪律（与 session.ts registerMetaTools 同款兜底） ----------

/** meta 工具错误统一映射（isError，绝不冒泡崩 stdio 进程——R4 meta 兜底纪律） */
function metaError(message: string): CallToolResult {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** 临时目录清理：清理失败不掩盖原始错误（Windows 句柄占用可能使 rmSync 抛错） */
function cleanupTmp(tmpDir: string): void {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 保留原始错误优先暴露 */
  }
}

// ---------- 参数解析与早校验（无副作用阶段：任何失败不触碰工作区） ----------

interface ImportArgs {
  xlsxPath: unknown;
  workspaceName: unknown;
  sheets: unknown;
}

/** module/file 写入路径组件校验：拒路径分隔符与 .. 序列（防临时目录内路径逃逸） */
function isValidPathComponent(value: string): boolean {
  return value.length > 0 && !/[\\/]/.test(value) && !value.includes("..");
}

/**
 * 构建 sheet 导入规格：缺省导入全部 sheet（module="import"、file=sheet 名、
 * headerRows 启发式）；显式 sheets 数组时逐项校验（sheet 名必须存在于工作簿、
 * headerRows 须为 1|2、module/file 须为合法路径组件），显式 headerRows 优先。
 */
function buildSheetSpecs(wb: XLSX.WorkBook, sheets: unknown): SheetSpec[] | string {
  if (sheets === undefined || sheets === null) {
    return wb.SheetNames.map((name) => ({
      sheet: name,
      module: "import",
      file: name,
      headerRows: detectHeaderRows(sheetToMatrix(wb, name)),
    }));
  }
  if (!Array.isArray(sheets)) {
    return "sheets 参数须为数组（每项指定 sheet/module/file/headerRows）";
  }
  if (sheets.length === 0) {
    return "sheets 为空数组（导入全部 sheet 请省略 sheets 参数）";
  }
  const specs: SheetSpec[] = [];
  const seenOutputs = new Set<string>();
  for (let i = 0; i < sheets.length; i += 1) {
    const item = (sheets[i] ?? {}) as Record<string, unknown>;
    const sheetName = item.sheet;
    if (typeof sheetName !== "string" || sheetName.length === 0) {
      return `sheets[${i}] 缺少 sheet 名（string，须来自工作簿的 sheet 列表）`;
    }
    if (!wb.Sheets[sheetName]) {
      return `sheets[${i}].sheet 不存在: ${sheetName}（工作簿含: ${wb.SheetNames.join(", ")}）`;
    }
    const mod = item.module === undefined ? "import" : item.module;
    if (typeof mod !== "string" || !isValidPathComponent(mod)) {
      return `sheets[${i}].module 须为非空字符串（禁路径分隔符与 ..）`;
    }
    const file = item.file === undefined ? sheetName : item.file;
    if (typeof file !== "string" || !isValidPathComponent(file)) {
      return `sheets[${i}].file 须为非空字符串（禁路径分隔符与 ..）`;
    }
    const outputKey = `${mod}/${file}`;
    if (seenOutputs.has(outputKey)) {
      return `sheets[${i}] 与更早项重复指向同一输出表（${outputKey}）——每项的 module/file 组合须唯一`;
    }
    seenOutputs.add(outputKey);
    const headerRows =
      item.headerRows === undefined
        ? detectHeaderRows(sheetToMatrix(wb, sheetName))
        : item.headerRows;
    if (headerRows !== 1 && headerRows !== 2) {
      return `sheets[${i}].headerRows 须为 1 或 2（表头行数，缺省由启发式探测）`;
    }
    specs.push({ sheet: sheetName, module: mod, file, headerRows });
  }
  return specs;
}

// ---------- 核心 handler ----------

async function handleImport(args: unknown, session: McpSessionState): Promise<CallToolResult> {
  const { xlsxPath, workspaceName, sheets } = (args ?? {}) as ImportArgs;

  // 1. xlsxPath 存在性 + 后缀校验（早失败，无副作用）
  if (typeof xlsxPath !== "string" || xlsxPath.length === 0) {
    return metaError("缺少 xlsxPath 参数（string，本地 xlsx 文件绝对路径）");
  }
  // UNC/网络路径前置拒绝：statSync 对不可达 SMB 主机的解析可达数十秒，期间整个
  // stdio 进程停摆（同步 fs 无并发），必须在触碰文件系统前拦截
  if (/^[\\/]{2}/.test(xlsxPath)) {
    return metaError(
      "不支持 UNC/网络路径（//server/share/...）：网络路径解析可能长时间阻塞本进程，" +
        "请先把文件复制到本地磁盘再导入",
    );
  }
  const absPath = resolve(xlsxPath);
  let stat: ReturnType<typeof statSync> | null = null;
  try {
    stat = statSync(absPath);
  } catch {
    stat = null;
  }
  if (!stat) {
    return metaError(`文件不存在: ${absPath}，请确认 xlsxPath 为本地 xlsx 文件绝对路径`);
  }
  if (!stat.isFile()) {
    return metaError(`路径存在但不是文件（可能是目录）: ${absPath}`);
  }
  if (!/\.xlsx$/i.test(absPath)) {
    return metaError(`仅支持 .xlsx 文件: ${absPath}（xls/csv 等旧格式请先另存为 .xlsx）`);
  }

  // 2. 工作区名：缺省取文件名 stem，与 set_workspace 同源 sanitize 白名单防穿越
  const stem = basename(absPath).replace(/\.xlsx$/i, "");
  const requested =
    typeof workspaceName === "string" && workspaceName.length > 0 ? workspaceName : stem;
  const clean = sanitizeWorkspaceName(requested);
  if (!clean) {
    return metaError(
      `非法工作区名: ${requested}（仅允许字母/数字与 -._，首字符须为字母/数字）；` +
        `请在 workspaceName 参数显式指定合法工作区名`,
    );
  }

  // 3. 读工作簿（损坏文件抛异常 → 诚实拒绝，不产半成品）
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.readFile(absPath);
  } catch (error) {
    return metaError(
      `xlsx 文件解析失败（文件可能已损坏）: ${absPath}：${(error as Error).message}`,
    );
  }
  if (wb.SheetNames.length === 0) {
    return metaError(`工作簿不含任何 sheet: ${absPath}`);
  }

  // 4. sheet 规格解析（早失败，无副作用）
  const specsOrError = buildSheetSpecs(wb, sheets);
  if (typeof specsOrError === "string") return metaError(specsOrError);
  const specs = specsOrError;

  // 5. 临时目录装配 → 全部成功后原子替换（Windows：rename 不能覆盖非空目录）
  const workspacesRoot = session.workspacesRoot;
  const tmpDir = join(workspacesRoot, `.tmp-${clean}-${Date.now()}`);
  try {
    const tables: TableIndexEntry[] = [];
    const tableSummaries: ImportTableSummary[] = [];
    for (const spec of specs) {
      const parsed = importSheet(tmpDir, wb, spec);
      tables.push(parsed.indexEntry);
      tableSummaries.push({
        sheet: spec.sheet,
        table: parsed.indexEntry.table,
        module: spec.module,
        rows: parsed.indexEntry.rows,
        columns: parsed.indexEntry.columns,
        headerRows: spec.headerRows,
        columnPatterns: parsed.indexEntry.columnPatterns,
      });
    }
    // sources 只写中性文件名（数据源路径不出工作区，沿 workspace-import 约定）
    writeWorkspaceJson(tmpDir, {
      project: clean,
      name: clean,
      sources: [basename(absPath)],
      tables,
    });

    const targetDir = join(workspacesRoot, clean);
    const replaced = existsSync(targetDir);
    // 两步 rename 原子替换（同卷 rename 原子）：先把旧目录改名到 .old- 备份位，
    // 新装配就位成功后再删备份；中途任何失败旧工作区原样恢复——rm 先行的旧实现
    // 在「rm 成功、rename 失败」窗口期会旧删新弃且不可恢复，违背 R4「旧工作区保持完好」
    let backupDir: string | null = null;
    if (replaced) {
      backupDir = join(workspacesRoot, `.old-${clean}-${Date.now()}`);
      renameSync(targetDir, backupDir);
    }
    try {
      renameSync(tmpDir, targetDir);
    } catch (renameError) {
      if (backupDir) {
        try {
          renameSync(backupDir, targetDir);
        } catch (restoreError) {
          // 恢复也失败（同卷同位 rename，实践中近不可达）：保留备份位供手工找回，如实报告
          throw new Error(
            `替换阶段失败且旧工作区自动恢复也失败——新装配错误: ${(renameError as Error).message}；` +
              `恢复错误: ${(restoreError as Error).message}；备份目录保留于 ${backupDir}`,
          );
        }
      }
      throw renameError;
    }
    if (backupDir) {
      try {
        rmSync(backupDir, { recursive: true, force: true });
      } catch {
        /* 备份清理失败不否定导入成功（.old- 首字符在白名单外，set_workspace 不可激活） */
      }
    }

    // 6. 成功后自动切换当前工作区
    const switchResult = session.setWorkspace(clean);
    if (!switchResult.success) {
      return metaError(`工作区已装配但切换失败: ${switchResult.error}`);
    }
    const summary: ImportSummary = {
      workspace: clean,
      workspaceRoot: switchResult.data.workspaceRoot,
      replaced,
      tableCount: tableSummaries.length,
      tables: tableSummaries,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(summary) }],
      structuredContent: summary as unknown as Record<string, unknown>,
    };
  } catch (error) {
    cleanupTmp(tmpDir);
    return metaError(
      `import_xlsx 装配失败（临时目录已清理，旧工作区未受影响）: ${(error as Error).message}`,
    );
  }
}

// ---------- 工具注册 ----------

/** 注册 import_xlsx meta 工具（Wave2：注册面 16→17）；handler 统一 try-catch 兜底 */
export function registerImportXlsxTool(server: McpServer, session: McpSessionState): void {
  server.registerTool(
    "import_xlsx",
    {
      description:
        "从本地 xlsx 文件（绝对路径）导入并创建工作区：读取工作簿全部 sheet" +
        "（或 sheets 参数指定子集），双行表头自动合并为「父.子」复合列名，数值列自动识别" +
        "等差/等比/常数模式，装配为规范化 tables/*.json + workspace.json 并设为当前工作区。" +
        "headerRows 缺省由启发式探测（结果随摘要回显，探测失误可显式指定 1/2 重试）；" +
        "同名工作区整体覆盖重建。导入后即可用 list_tables / read_table / audit_column 等工具审计数值。",
      inputSchema: fromJsonSchema(
        {
          type: "object",
          properties: {
            xlsxPath: {
              type: "string",
              description: "本地 xlsx 文件绝对路径（Windows 正反斜杠均可，内部归一）",
            },
            workspaceName: {
              type: "string",
              description:
                "工作区名（可选；缺省取文件名去扩展名。仅允许字母/数字与 -._，首字符须为字母/数字）",
            },
            sheets: {
              type: "array",
              description:
                "导入 sheet 子集与覆盖（可选；缺省导入全部 sheet，module=import，headerRows 自动探测）",
              items: {
                type: "object",
                properties: {
                  sheet: { type: "string", description: "xlsx 内的 sheet 名" },
                  module: { type: "string", description: "输出模块目录（缺省 import）" },
                  file: { type: "string", description: "输出文件名（缺省同 sheet 名）" },
                  headerRows: {
                    type: "number",
                    enum: [1, 2],
                    description: "表头行数（缺省启发式探测；双行表头合并为父.子复合列名）",
                  },
                },
                required: ["sheet"],
              },
            },
          },
          required: ["xlsxPath"],
          additionalProperties: false,
        },
        passthroughValidator,
      ),
    },
    async (args: unknown): Promise<CallToolResult> => {
      try {
        return await handleImport(args, session);
      } catch (error) {
        return metaError(`import_xlsx 执行异常: ${(error as Error).message}`);
      }
    },
  );
}
