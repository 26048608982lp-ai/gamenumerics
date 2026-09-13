/**
 * 迷你表达式求值器 — 四则 + 幂 + 括号 + 变量（支持中文变量名），递归下降
 *
 * 用途：锚点公式的确定性求值（如 攻击 = 100 * 1.05 ^ (等级 - 1) 的对账重算）。
 * 边界声明：不实现 Excel 函数库/单元格引用/跨表——只有算术与变量替换。
 */

type Token =
  | { kind: "num"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "op"; op: "+" | "-" | "*" | "/" | "^" | "(" | ")" };

const IDENT_START = /[A-Za-z_\u4e00-\u9fff]/;
const IDENT_CHAR = /[A-Za-z0-9_\u4e00-\u9fff]/;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
      if (!m) throw new Error(`表达式非法数字: ${src.slice(i, i + 10)}`);
      tokens.push({ kind: "num", value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < src.length && IDENT_CHAR.test(src[j])) j += 1;
      tokens.push({ kind: "ident", name: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/^()".includes(ch)) {
      tokens.push({ kind: "op", op: ch as "+" | "-" | "*" | "/" | "^" | "(" | ")" });
      i += 1;
      continue;
    }
    throw new Error(`表达式含不支持的字符: "${ch}"（仅支持四则/幂/括号/变量）`);
  }
  return tokens;
}

export function evalExpression(expr: string, variables: Record<string, number> = {}): number {
  const tokens = tokenize(expr);
  if (tokens.length === 0) throw new Error("表达式为空");
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const eatOp = (op: string): boolean => {
    const t = peek();
    if (t?.kind === "op" && t.op === op) {
      pos += 1;
      return true;
    }
    return false;
  };

  // expr := term (('+'|'-') term)*
  function parseExpr(): number {
    let left = parseTerm();
    for (;;) {
      if (eatOp("+")) left += parseTerm();
      else if (eatOp("-")) left -= parseTerm();
      else return left;
    }
  }

  // term := unary (('*'|'/') unary)*
  function parseTerm(): number {
    let left = parseUnary();
    for (;;) {
      if (eatOp("*")) left *= parseUnary();
      else if (eatOp("/")) {
        const d = parseUnary();
        if (d === 0) throw new Error("表达式除零");
        left /= d;
      } else return left;
    }
  }

  // unary := '-' unary | power
  function parseUnary(): number {
    if (eatOp("-")) return -parseUnary();
    return parsePower();
  }

  // power := primary ('^' unary)?  右结合
  function parsePower(): number {
    const base = parsePrimary();
    if (eatOp("^")) return Math.pow(base, parseUnary());
    return base;
  }

  function parsePrimary(): number {
    const t = peek();
    if (!t) throw new Error("表达式意外结束");
    if (t.kind === "num") {
      pos += 1;
      return t.value;
    }
    if (t.kind === "ident") {
      pos += 1;
      const v = variables[t.name];
      if (v === undefined || typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`表达式变量未提供或非数值: ${t.name}`);
      }
      return v;
    }
    if (t.kind === "op" && t.op === "(") {
      pos += 1;
      const v = parseExpr();
      if (!eatOp(")")) throw new Error("表达式括号不闭合");
      return v;
    }
    throw new Error(`表达式此处不应出现: ${JSON.stringify(t)}`);
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new Error(`表达式末尾有多余内容: ${JSON.stringify(tokens[pos])}`);
  if (!Number.isFinite(result)) throw new Error("表达式结果非有限数");
  return result;
}
