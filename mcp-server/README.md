# mcp-server-gamenumerics

> **MCP server for game numerical design & balance auditing.** 17 deterministic tools that let your AI coding agent (Claude Code, Cursor, ZCode, or any MCP host) import xlsx config tables, audit growth curves, run battle/gacha simulations, and reverse-engineer the formulas behind game spreadsheets — every numeric answer comes from deterministic pure-function engines, zero LLM guessing.

**Who it's for**: game designers and solo/small teams doing roguelike / deckbuilder balance work, spreadsheet-driven numerical design, or live-ops tuning audits — no engine integration required, just an xlsx export of your config tables.

**What you get — 17 tools**: `import_xlsx` (dual-row header merge + column-pattern detection) · `list_tables` / `read_table` (workspace read, filter & paginate) · `battle_simulate` / `simulate_gacha` (Monte Carlo) / `compute_power` (EHP×EDPS) / `power_curve` / `eval_formula` / `audit_column` (expected-vs-actual reconciliation) / `infer_column_rule` (Theil-Sen robust fitting) / `infer_table_relation` (base×coefficient structures) · `grade_workspace` / `profile_table` / `infer_foreign_keys` (structure analysis) · `list_workspaces` / `set_workspace` / `read_memory` (session meta). Read-only surface — write tools stay behind the web workbench's human-in-the-loop confirm flow.

**Quick start** (Node.js 18+):

```bash
npx -y mcp-server-gamenumerics
```

```json
{ "mcpServers": { "gamenumerics": { "command": "npx", "args": ["-y", "mcp-server-gamenumerics"] } } }
```

**Performance**: ~150ms cold start (spawn → initialize → tools/list) · ~79MB idle memory · 17 tools · clean exit on stdin close.

**Verified hosts**: ZCode ✓ · Claude Code ✓ — per-host config snippets below; host-verification log in [HOST-VERIFICATION.md](HOST-VERIFICATION.md).

---

以下为中文详细文档。

游戏数值设计 Agent 工作站的 MCP（Model Context Protocol）形态——**read/算/审计面**的 stdio server。

把本项目 agent harness 的 20+ 个零依赖纯函数数值引擎，以 **14 个只读数值工具 + 3 个会话 meta 工具**（共 17 个）带给任意 MCP 宿主（Claude Code / Cursor / ZCode 等）：在开发者自己的 AI 编辑器里直接说「检查这份 HeroGrowth.xlsx 的数值曲线」，宿主 LLM 即可完成导入 → 查表 → 曲线审计的完整链路。

核心叙事一句话：**LLM 负责理解、编排、解释；确定性引擎负责数值正确性**——所有数值结论都出自确定性纯函数，不依赖 LLM 心算。

## 安装与启动

前置：Node.js 18+。

**方式一：npx 免安装直跑（推荐，宿主配置推荐写法）**

```bash
npx -y mcp-server-gamenumerics
```

**方式二：全局安装**

```bash
npm install -g mcp-server-gamenumerics
gnd-mcp # 本包配置了 bin: gnd-mcp，全局安装后直接以该命令启动
```

**方式三：从源码运行（开发者路径）**

```bash
# 在 mcp-server/ 目录内
npm install        # 安装 @modelcontextprotocol/server
npm run build      # esbuild bundle 出单文件 dist/index.js
node dist/index.js # 即 stdio server（stdin/stdout 通信，直接运行会等待输入，属正常）
```

`npx .`（在 mcp-server/ 目录内）与 `node dist/index.js` 等价可用。

## 环境变量

| 变量 | 说明 | 缺省 |
|------|------|------|
| `GND_WORKSPACES_DIR` | 工作区根目录（**建议绝对路径**；相对值按用户主目录解析，不依赖进程 cwd）——import_xlsx 装配产物落于此，写侧严格限于该目录内 | `~/.gamenumerics/workspaces` |

MCP 用户机器上无本仓库源码，工作区绝不落到仓库 `workspaces/` 目录。`import_xlsx` 只接受本地磁盘路径（UNC/网络路径 `//server/...` 前置拒绝——网络解析可能长时间阻塞进程）。

## 宿主配置

以下配置提供两种接入形态：`npx` 形式直接使用 npm 包（推荐，无需本仓库源码）；本地路径形式供源码开发者使用，其中的 `<仓库绝对路径>` 替换为本仓库实际路径（Windows 路径正反斜杠均可）。

### Claude Code

npx 形式（推荐）：

```bash
claude mcp add gamenumerics --env GND_WORKSPACES_DIR=D:/mcp-workspaces -- npx -y mcp-server-gamenumerics
```

本地路径形式（源码开发者用）：

```bash
claude mcp add gamenumerics -- node <仓库绝对路径>/mcp-server/dist/index.js
```

可选指定工作区根（本地路径形式；npx 形式同样加 `--env` 即可）：

```bash
claude mcp add gamenumerics --env GND_WORKSPACES_DIR=D:/mcp-workspaces -- node <仓库绝对路径>/mcp-server/dist/index.js
```

### Cursor

项目级 `.cursor/mcp.json`（或用户级全局配置）。

npx 形式（推荐）：

```json
{
  "mcpServers": {
    "gamenumerics": {
      "command": "npx",
      "args": ["-y", "mcp-server-gamenumerics"],
      "env": { "GND_WORKSPACES_DIR": "D:/mcp-workspaces" }
    }
  }
}
```

本地路径形式（源码开发者用）：

```json
{
  "mcpServers": {
    "gamenumerics": {
      "command": "node",
      "args": ["<仓库绝对路径>/mcp-server/dist/index.js"],
      "env": { "GND_WORKSPACES_DIR": "D:/mcp-workspaces" }
    }
  }
}
```

### ZCode

在 ZCode 的 MCP 配置（项目级 `.zcode/mcp.json` 或用户级配置文件，以所用版本文档为准）中加入同形态的 `mcpServers` 条目——`npx` 形式与本地 `node` 路径形式皆可。

npx 形式（推荐）：

```json
{
  "mcpServers": {
    "gamenumerics": {
      "command": "npx",
      "args": ["-y", "mcp-server-gamenumerics"],
      "env": { "GND_WORKSPACES_DIR": "D:/mcp-workspaces" }
    }
  }
}
```

本地路径形式（源码开发者用）：

```json
{
  "mcpServers": {
    "gamenumerics": {
      "command": "node",
      "args": ["<仓库绝对路径>/mcp-server/dist/index.js"],
      "env": { "GND_WORKSPACES_DIR": "D:/mcp-workspaces" }
    }
  }
}
```

配置后重启宿主，工具列表中出现 `import_xlsx` / `list_tables` 等 17 个工具即接入成功。

## 性能基线

| 指标 | 数值 |
|------|------|
| 冷启动（spawn → initialize → tools/list 全链） | ~150ms |
| 空闲内存（握手完成后单进程） | ~79MB |
| 工具面 | 17 个（14 映射 + 3 meta） |
| stdin 关闭 | 干净退出，无残留进程 |

测量条件：Windows 11 / Node v24 / 单进程空闲态——数字随环境浮动。复现命令（仓库根目录）：`npx tsx scripts/mcp-benchmark.ts`（3 轮独立子进程取中位）。

内存大头是 Node.js 运行时基线（空进程 ~48MB），本包从 34 工具 registry 到 17 工具面的全链业务增量克制在 ~30MB——在「MCP server 动辄 100-200MB」是社区普遍抱怨的背景下，这是选型上的差异点。

## 工具面清单（17 = 14 映射 + 3 meta）

### 会话 meta 工具（3）

| 工具 | 职责 |
|------|------|
| `import_xlsx` | 从本地 xlsx（绝对路径）导入并创建工作区：双行表头合并「父.子」列名、数值列自动识别等差/等比/常数模式，成功后设为当前工作区 |
| `list_workspaces` | 列出工作区根下全部可用工作区 |
| `set_workspace` | 按名切换当前工作区（后续全部数值工具作用于它） |

### 工作区读取（2）

| 工具 | 职责 |
|------|------|
| `list_tables` | 列出当前工作区全部数值表清单（表名/模块/行数/列名） |
| `read_table` | 读取指定表的数据行（支持列选择/条件过滤/分页） |

### 数值计算与审计（8）

| 工具 | 职责 |
|------|------|
| `battle_simulate` | 战斗模拟（属性/伤害数值计算） |
| `simulate_gacha` | 抽卡概率计算 + Monte Carlo 模拟 |
| `compute_power` | 属性 → 战力（EHP×EDPS 解析式单源计算） |
| `power_curve` | 批量战力曲线（多属性组对比） |
| `eval_formula` | 求值数值公式表达式 |
| `audit_column` | 列对账：实际值 vs 生成规则期望值的偏离点审计 |
| `infer_column_rule` | 列规则逆向推断（Theil-Sen 稳健拟合等差/等比/幂律） |
| `infer_table_relation` | 列间派生关系推断（还原「各列 = 基准 × 系数」生成结构） |

### 结构分析（3）

| 工具 | 职责 |
|------|------|
| `grade_workspace` | 工作区数值质量评分 |
| `profile_table` | 单表结构画像 |
| `infer_foreign_keys` | 表间外键关系推断 |

### 记忆（1）

| 工具 | 职责 |
|------|------|
| `read_memory` | 读工作区记忆文件（PROFILE/facts，缺省回落公共 facts） |

> 面边界说明：本 MCP 形态只暴露只读面——写表/规划/问卷/交付导出等依赖人在回路确认面板、登录身份或前端 UI 载荷的工具不在 stdio 面提供。

## 使用示例

对话示例（任意 MCP 宿主中）：

> **用户**：检查这份 D:/data/HeroGrowth.xlsx 的数值曲线

宿主 LLM 的典型编排（工具调用链）：

1. `import_xlsx` `{ "xlsxPath": "D:/data/HeroGrowth.xlsx" }`
   → 返回摘要：工作区 `HeroGrowth`、1 张表 `import/HeroGrowth`（3 行，双行表头探测 headerRows=2，`成长` 列为等比 1.1）
2. `read_table` `{ "table": "import/HeroGrowth" }` → 读回行数据确认口径
3. `infer_column_rule` 对 `成长` 列逆向拟合生成规则
4. `audit_column` `{ "table": "import/HeroGrowth", "column": "成长", "rule": "<上一步推断的表达式>" }` → 对账偏离点（疑似手调值）

若 headerRows 启发式探测失误（摘要回显可疑列名），在 `import_xlsx` 显式传 `"sheets": [{ "sheet": "HeroGrowth", "headerRows": 1 }]` 重试即可。

## 开发

```bash
# 类型检查（mcp-server 自带独立 tsconfig，根 tsc exclude 本目录）
npm run check

# 单测（经根仓库 vitest 收集：npm test，文件级 @vitest-environment node）
cd .. && npx vitest run mcp-server/__tests__/

# 真机冒烟（stdio 子进程拉起 dist/index.js 全链路，不进 CI；上一行 cd .. 后即处于仓库根目录）
npx tsx scripts/mcp-smoke.ts
```

架构一页纸见仓库 `docs/agent-harness-architecture.md`；本包 Spec 见 `docs/specs/v9-w2-mcp-server-spec.md`。
