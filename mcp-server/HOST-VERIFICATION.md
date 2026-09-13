# MCP 宿主真机验证记档

> 验证日期：2026-09-12 ｜ 验证人：AI 全程代办（用户裁决 ZCode 宿主优先）
> 宿主环境：**ZCode 0.16.5**（Windows 11，stdio，会话级隔离）+ 宿主 LLM GLM-5.3
> 被测：`mcp-server-gamenumerics` 0.1.0（PR #215 set_fs 修复 + PR #216 依赖显式化之后的构建）
> 性质：W2 Spec 遗留「宿主真机验证（用户侧动作）」的交付物——**npm 发布决策的输入**

## 一、验证金字塔定位

| 层 | 手段 | 结论 |
|---|------|------|
| 单测（CI） | 映射器 34 round-trip / 工具面 17 三向闭合 / import 装配（43 用例） | 逻辑正确 |
| 冒烟 | SDK Client 子进程全链（握手→tools/list 17→七步断言） | 参考客户端可正常工作 |
| **宿主真机（本记档）** | ZCode 宿主 + 宿主 LLM 语义路由自然语言任务 | **可用性成立，3 项发现** |

## 二、剧本结果（全部通过）

| # | 剧本项 | 结果 |
|---|--------|------|
| 1 | 会话启动自动连接（用户级 config） | ✓ `mcp.server.connected`：connectDurationMs 636-1090 / listTools **toolCount=17** / 协议 2026-07-28（modern era） |
| 2 | `list_workspaces` 空状态 | ✓ 空列表（GND_WORKSPACES_DIR 隔离生效） |
| 3 | `import_xlsx` 真实外包表（441KB / 20 sheet） | ✓ 20 表装配、双行表头启发式命中（`设定` headerRows=2 复合键）、列模式识别（等差序号） |
| 4 | `read_table` 读回 + 分页 | ✓ 61 行表 limit=5 正常（含 xlsx 公式注释行原样返回） |
| 5 | `infer_column_rule` ×2 | ✓ 「属性」列 100% 命中 `95+5×i`；「经验消耗」诚实判定「无单一规则」（真实表为查表设计） |
| 6 | `audit_column` 对账（推断产物→expression 复核） | ✓ 60 行全符合公式 |
| 7 | `power_curve` 无标准属性列边角 | ✓ isError + 引导显式 columns 指定 |
| 8 | `compute_power` 真实表面板 | ✓ EDPS/EHP/边际价值 + assumptions 诚实声明 |
| 9 | `read_table` 不存在表名边角 | ✓ isError + 引导 list_tables |
| — | 宿主 LLM 编排观察 | ✓ 语义路由正确（自然语言→正确工具+参数，read/infer 并行独立调用自然发生） |

## 三、发现与处置

| # | 发现 | 定性 | 处置 |
|---|------|------|------|
| F1 | **W3 SheetJS 换源涟漪**：重建 bundle 后 `import_xlsx` 全链死（esbuild ESM 解析 `xlsx.mjs` 无 fs，`readFile` 报 Cannot access file）；W2 旧 dist 解析 0.18.5 CJS 故冒烟一直假 PASS | server bug（生产面） | ✓ **PR #215 已修**：显式 `XLSX.set_fs(node:fs)`；冒烟 RED→GREEN 实证 |
| F2 | **中文文件名首体验摩擦**：`import_xlsx` 以文件名推断工作区名，中文名直接被拒（sanitize 白名单 fail-closed 正确+引导文案），但中文用户外包表大概率中文名 | 产品体验改进候选 | 记 Backlog：自动转写（拼音/时间戳）兜底而非要求显式传 `workspaceName` |
| F3 | **ZCode 宿主单工具丢失（17→16）**：宿主连接层三次连接 `toolCount=17`（schema 正常、协议协商正常），但模型工具面仅注入 16 个——恰好缺 `infer_foreign_keys` | **宿主侧**（ZCode 连接层→模型注入层），server 无罪 | 观察项：ZCode 宿主下外键悬挂审计不可达（/agent 工作台与其他宿主不受影响）；**Claude Code / Cursor 交叉验证时确认**——彼处 17/17 则 ZCode 专属，彼处也 16 则重开 server 端排查 |
| F4 | stdio 进程树清理偶发失败（`taskkill failed`，Windows） | 宿主侧观察级 | 僵尸 node 进程风险，留意即可 |
| F5 | 用户级配置 = 所有工作区会话均拉起本 server（Resume / FinancialCounseler 会话日志实证） | 预期行为（用户级语义） | 若不想全局常驻，可改 workspace 级配置（`<repo>/.zcode/config.json`） |

## 四、结论

- **ZCode 宿主可用性成立**：自然语言→正确工具编排链（导入→查→读→推断→对账→算）全通，错误路径引导文案符合设计，连接/协议/性能（冷启动 ~1s）全部健康。
- **发布前置就绪**：依赖显式化（PR #216，xlsx tarball + esbuild + lock 入库）后，`npm publish` 的工程条件已齐；发布动作本身仍待用户确认（W2 Spec 裁决维持）。
- ~~遗留：跨宿主交叉验证~~ → **Claude Code 已完成（见 §六），Cursor 经用户裁决跳过（2026-09-12）**；F2 中文名兜底 + F6 守卫细分留 Backlog。

## 五、性能基线与优化记账（2026-09-12）

**1. 基准面（性能回归护栏）**：冷启动 ~146ms（spawn → initialize → tools/list 全链）/ 空闲 RSS ~78.7MB（握手完成后，Windows WorkingSetSize 口径）/ stdin EOF 干净退出 3/3。固化于 `scripts/mcp-benchmark.ts`（仓库根 `npx tsx scripts/mcp-benchmark.ts`，3 轮独立子进程取中位）——后续加工具/加依赖时对照此基线，防性能回归无声滑落。

**2. xlsx lazy import 探针结论（已 revert，只记结论）**：把 SheetJS 从启动加载改为首次 `import_xlsx` 调用时动态加载，**技术上成立**——esbuild 对动态 import 以 init 包装内联、启动链不触及（首次调用实测耗时 ~42ms 含一次性模块加载、调用后进程 +9.9MB，证明启动时确实未加载）；但空闲 RSS 仅降 ~0.3MB，远低于 5MB 门槛：xlsx **模块体**的驻留成本本就低，+9.9MB 是**调用期解析工作内存**（readFile 缓冲/工作簿对象，eager 模式同样只在调用时产生）。按门槛裁决 revert，结论沉淀：单进程内存被 Node.js 基线（空进程 ~48MB）锁死，server 侧内存优化优先级让位于 TTFC。

**3. Theil-Sen 性能债（跨域记账，本域不排期）**：`infer_column_rule` 全链 ~7.2s，瓶颈在 `lib/table/pattern.ts` 的 Theil-Sen 稳健拟合；消费方三方（agent 工具 / mcp-server / `/checkup` 体检页）；`lib/table` 为共享文件跨域，归 **lib/agent 域**排期——用户感知最强的性能优化项。

## 六、跨宿主验证：Claude Code（2026-09-12，第二宿主）

> 宿主：**Claude Code CLI 2.1.212**（Windows 11，`claude -p` 非交互剧本）；配置：`claude mcp add gamenumerics --env GND_WORKSPACES_DIR=D:/mcp-workspaces -- node <dist>`（local 级，验后已清理）；被测与 ZCode 验证同一 dist（PR #215 后零源码改动）。

| # | 剧本项 | 结果 |
|---|--------|------|
| 1 | 连接 + **F3 对照（LLM 报工具名单）** | ✓ **17/17 全注册，`infer_foreign_keys` 在列——F3 判定落定：ZCode 注入层专属问题，server 普遍缺陷排除** |
| 2 | import_xlsx 中文文件名（F2 对照） | ✓ F2 复现（sanitize 是 server 端规则，与宿主无关）且 **LLM 读错误文案一次重试自愈**（自起名 `core-loop-0118`，20 表装配 + 双行表头 + 列模式与 ZCode 一致）——两宿主错误恢复行为一致 |
| 3 | infer_column_rule + audit_column 链 | ✓ LLM 交叉验证：fitPct 0.0944 与对账吻合行 17/180 精确一致；对查表结构列诚实判定「单一曲线审计前提不成立」而非乱报手调 |
| 4 | compute_power | ✓ LLM 算术复核 √(1200×256.25)=554.5268… 逐位吻合；assumptions 数组原文返回 |
| 5 | 错误路径 ×2 | ✓ 「表不存在 / 工作区不存在」文案自包含引导 |

**新发现**：

| # | 发现 | 定性 | 处置 |
|---|------|------|------|
| F6 | `compute_power` 等不依赖工作区数据的纯计算工具也被「未设工作区」会话守卫拦截 | 统一保守卫的代价——ZCode 长会话形态不暴露；Claude Code 每次 `-p` 拉起独立无状态会话暴露（工具说明与守卫矛盾：read/算工具声称可先算后导） | Backlog：guard 按工具是否需工作区细分（session.ts 单点） |
| F7 | 宿主进程模型差异：Claude Code 每次 `-p` 独立 server 子进程（无状态），ZCode 长会话常驻 | 预期行为（宿主语义），两种形态 server 均健康（EOF 干净退出 3/3 已验） | 记档即可 |

**验证金字塔收官判定**：两宿主（ZCode + Claude Code）真机全绿 + 用户裁决跳过 Cursor——**发布决策输入齐备，npm publish 解禁**。

## 七、npm 发布记录（2026-09-12，两宿主全绿后用户拍板）

| 步骤 | 结果 |
|------|------|
| 发布前置 | 包名核查可用 / files 白名单收敛（误含 41KB 测试文件、漏 dist——修正后 4 文件）/ bin shebang 修复（esbuild CLI banner 不解析转义 + Windows cmd 换行截断双坑，改走 JS API）/ README 反转「发布待定」为 npx 主推形态 |
| **0.1.0 发布事故** | 首发成坏包：仓库根 `private:true` 拦 publish（npm 向上应用 monorepo 根标记）→ 改独立临时目录发布时把 `dist/index.js` 拷为根级 `index.js`，files 白名单命中 `dist` 目录——**包内无 bin 目标，npx 必崩**；unpublish 403（granular token 无 unpublish 权限） |
| 0.1.1 修复版 | 版本号推进 + 正确 dist/ 结构发布成功；`npm deprecate` 标记 0.1.0 引导升级；`latest` tag 指向 0.1.1 |
| **发布后真机冒烟** | ✓ registry 真实拉包：`npx -y mcp-server-gamenumerics` → initialize 响应 + **17 工具**——发布链完整闭环 |

**教训**：发布验收不能止于 `npm pack --dry-run` 看清单——必须在**发布后从 registry 重新安装**并起 server 冒烟（本次 dry-run 两误：白名单误含测试文件、临时目录结构错误均在 dry-run 可见而未核）；granular token 默认无 unpublish 权限，首发事故只能版本推进兜底（unpublish 72h 窗口需账号级操作）。
