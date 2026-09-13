# gamenumerics

> **Deterministic numeric engines for game design — exposed to your AI coding agent via MCP.**
> Import xlsx config tables, audit growth curves, run battle/gacha simulations, and reverse-engineer the formulas behind game spreadsheets. Every numeric answer comes from zero-dependency pure-function engines — zero LLM guessing.

**Who it's for**: game designers and solo/small teams doing roguelike / deckbuilder balance work, spreadsheet-driven numerical design, or live-ops tuning audits — no engine integration required, just an xlsx export of your config tables.

## Quick start (MCP server)

The fastest way to use these engines is through [`mcp-server-gamenumerics`](https://www.npmjs.com/package/mcp-server-gamenumerics) — a stdio MCP server exposing 17 read-only tools to Claude Code, Cursor, ZCode, or any MCP host:

```bash
npx -y mcp-server-gamenumerics
```

```json
{ "mcpServers": { "gamenumerics": { "command": "npx", "args": ["-y", "mcp-server-gamenumerics"] } } }
```

Full per-host config (Claude Code / Cursor / ZCode), the 17-tool reference, and the performance baseline live in [mcp-server/README.md](mcp-server/README.md).

## What's inside

| Path | What it is |
|------|------------|
| `lib/engine/formula-engine/` | 19 pure-function numeric engines: battle simulation, gacha probability + Monte Carlo, EHP×EDPS power model, growth projection, economy production/consumption, progression curves, level systems, difficulty mirroring |
| `lib/table/` | xlsx/spreadsheet normalization: dual-row header merge, column pattern detection (arithmetic/geometric), base×coefficient relation inference, Theil-Sen robust curve fitting |
| `lib/agent/tools/` | Tool definitions (JSON Schema + handlers) wrapping the engines — the read/audit surface |
| `mcp-server/` | The npm-distributed stdio MCP server (`mcp-server-gamenumerics`, esbuild single-file bundle) |
| `scripts/lib/workspace-import.ts` | xlsx → normalized JSON workspace import pipeline |

## Tool surface (17 = 14 mapped + 3 meta)

`import_xlsx` · `list_tables` / `read_table` · `battle_simulate` / `simulate_gacha` / `compute_power` / `power_curve` / `eval_formula` / `audit_column` / `infer_column_rule` / `infer_table_relation` · `grade_workspace` / `profile_table` / `infer_foreign_keys` · `list_workspaces` / `set_workspace` / `read_memory`

Read-only by design — write tools stay behind the web workbench's human-in-the-loop confirm flow (separate product, not part of this repo).

## Development

```bash
npm install
npm test         # vitest: engine + table + mcp-server suites
npm run check    # tsc --noEmit (lib + scripts)
npm run mcp:check  # tsc for mcp-server (own tsconfig)
npm run mcp:build  # esbuild bundle → mcp-server/dist/index.js
```

## License

[MIT](LICENSE)
