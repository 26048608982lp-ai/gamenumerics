"""
Smithery 发布管线：mcpb pack → 注入 tools[].inputSchema → smithery mcp publish

为什么需要注入：MCPB 0.3 规范的 tools 项是 strictObject({name, description?})，
不接受 inputSchema；而 Smithery 服务端要求 serverCard.tools 每项携带 inputSchema
（object），否则 release 报 400 "expected object, received undefined" ×N。
两边规范当前不兼容，故在 pack 产物（zip）侧注入——仓库内 manifest.json 保持规范合规。

用法（在 mcp-server/ 目录，需先 npx @anthropic-ai/mcpb pack .）：
  python pack-smithery.py            # 仅注入
  python pack-smithery.py --publish  # 注入并发布（需已 npx smithery auth login）
"""

import io
import json
import sys
import zipfile

SCHEMAS = {
    "import_xlsx": {"xlsxPath": {"type": "string", "description": "Absolute path to the local xlsx file"}},
    "list_workspaces": {},
    "set_workspace": {"name": {"type": "string", "description": "Workspace name from list_workspaces"}},
    "list_tables": {"module": {"type": "string", "description": "Optional module filter"}},
    "read_table": {"table": {"type": "string", "description": "Table name from list_tables"}, "limit": {"type": "number", "description": "Row limit (default 20)"}},
    "battle_simulate": {"player": {"type": "object", "description": "Player panel"}, "enemy": {"type": "object", "description": "Enemy panel"}},
    "simulate_gacha": {"mode": {"type": "string", "description": "tiers or pity"}},
    "compute_power": {"attrs": {"type": "object", "description": "Attribute panel"}},
    "power_curve": {"table": {"type": "string", "description": "Growth table name"}},
    "eval_formula": {"expression": {"type": "string", "description": "Formula expression"}},
    "audit_column": {"table": {"type": "string", "description": "Table name"}, "column": {"type": "string", "description": "Column to audit"}, "expression": {"type": "string", "description": "Expected formula"}},
    "infer_column_rule": {"table": {"type": "string", "description": "Table name"}, "column": {"type": "string", "description": "Numeric column"}},
    "infer_table_relation": {"table": {"type": "string", "description": "Table name"}},
    "grade_workspace": {},
    "profile_table": {"table": {"type": "string", "description": "Table name"}},
    "infer_foreign_keys": {"topN": {"type": "number", "description": "Max candidates"}},
    "read_memory": {},
}


def inject(mcpb_path: str) -> int:
    zin = zipfile.ZipFile(mcpb_path, "r")
    items = {i.filename: zin.read(i.filename) for i in zin.infolist()}
    zin.close()
    man = json.loads(items["manifest.json"].decode("utf-8"))
    for t in man.get("tools", []):
        props = SCHEMAS.get(t["name"], {})
        t["inputSchema"] = {"type": "object", "properties": props, "required": []}
    items["manifest.json"] = json.dumps(man, ensure_ascii=False, indent=2).encode("utf-8")
    zout = zipfile.ZipFile(mcpb_path, "w", zipfile.ZIP_DEFLATED)
    for name, data in items.items():
        zout.writestr(name, data)
    zout.close()
    return len(man.get("tools", []))


if __name__ == "__main__":
    n = inject("mcp-server.mcpb")
    print(f"mcpb patched: {n} tools with inputSchema")
    if "--publish" in sys.argv:
        import subprocess
        r = subprocess.run(
            ["npx", "-y", "smithery@latest", "mcp", "publish", "./mcp-server.mcpb", "-n", "26048608982lp/gamenumerics"],
            shell=(sys.platform == "win32"),
        )
        sys.exit(r.returncode)
