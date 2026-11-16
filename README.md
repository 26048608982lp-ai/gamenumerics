# gamenumerics

> **Deterministic numeric engines for game design — exposed to your AI coding agent via MCP.**
> Import xlsx/CSV config tables, audit growth curves, run battle/gacha simulations, reverse-engineer the formulas behind game spreadsheets — and pin numeric behavior with assertable contract baselines (FNV fingerprints you can gate in CI). Every numeric answer comes from zero-dependency pure-function engines — zero LLM guessing.

**Who it's for**: game designers and solo/small teams doing roguelike / deckbuilder balance work, spreadsheet-driven numerical design, or live-ops tuning audits — no engine integration required, just an xlsx/CSV export of your config tables.

## Quick start (two ways)

**npm stdio server** — [`mcp-server-gamenumerics`](https://www.npmjs.com/package/mcp-server-gamenumerics), 25 read-only tools for Claude Code, Cursor, ZCode, or any MCP host:

```bash
npx -y mcp-server-gamenumerics
```

```json
{ "mcpServers": { "gamenumerics": { "command": "npx", "args": ["-y", "mcp-server-gamenumerics"] } } }
```

**Remote endpoint (no install)** — paste one URL into hosts that support Streamable HTTP MCP (stateless, 8 pure-computation tools):

```
https://aigamedesign-johns-projects-c3a79938.vercel.app/api/mcp
```

Full per-host config, the 25-tool reference, file interop matrix (xlsx/CSV in → lua/json/contract baselines out), and the performance baseline live in [mcp-server/README.md](mcp-server/README.md).

## Engine as an npm package

[`gamenumerics-engine`](https://www.npmjs.com/package/gamenumerics-engine) — contract-first numeric domain: the same engines as a zero-dependency cjs+esm+dts package (`computeFromIntent`, turn-based battle balance, gacha pool audit, presets, FNV-1a baseline fingerprints). Embed the numeric domain in your own tooling or CI.

## What's inside

| Path | What it is |
|------|------------|
| `lib/engine/` | Pure-function numeric domain: formula engines, table normalization, tool definitions (see mirror note below) |
| `mcp-server/` | The stdio MCP server source (`mcp-server-gamenumerics`) |

> **Mirror note**: this repo mirrors the private dev workspace — the mirror may lag between syncs (current npm releases are ahead of the mirrored source). The npm registry and the remote endpoint are the source of truth for published behavior: CSV import, contract baselines, the engine package and the dual-consumer demo all ship in the npm artifacts and [mcp-server docs on npm](https://www.npmjs.com/package/mcp-server-gamenumerics).

## Tool surface (25 = 18 mapped + 7 meta)

`import_xlsx` (xlsx/CSV) · `list_tables` / `read_table` · `battle_simulate` / `simulate_gacha` / `compute_power` / `power_curve` / `eval_formula` / `audit_column` / `infer_column_rule` / `infer_table_relation` · `grade_workspace` / `profile_table` / `infer_foreign_keys` · `simulate_battle` / `audit_balance` · `audit_gacha_pool` · `get_genre_template` · `read_memory` · `export_table` (lua/json) · `export_baseline` (numeric contract) · `recon_diff` / `suggest_refs` · `list_workspaces` / `set_workspace`

Read-only by design — write tools stay behind the web workbench's human-in-the-loop confirm flow (separate product, not part of this repo).

## Numeric contracts (the differentiator)

- **`export_baseline`**: engine-computed baselines with FNV-1a input fingerprints — diff them in CI so numeric changes become visible contract regressions (CI workflow guide ships in the npm package docs)
- **formula_sheet**: 17 executable formula contracts (expression dialect + guard branches + sample anchors) — consumed identically by the engine and independent implementations (runnable demo ships with the engine package docs)

## Development

```bash
npm install
npm test         # vitest: engine + table + mcp-server suites
npm run check    # tsc --noEmit (lib + scripts)
npm run mcp:check  # tsc for mcp-server (own tsconfig)
npm run mcp:build  # esbuild bundle → mcp-server/dist/index.js
```

> This repo is a public mirror of the private dev workspace — npm releases may lead the mirror between syncs. The registry is the source of truth for published versions.

## License

[MIT](LICENSE)
