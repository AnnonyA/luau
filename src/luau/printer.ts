import type { Expr, Stmt, TableField } from "./ast";

const INDENT = "    ";

export function printChunk(body: Stmt[]): string {
  return printBlock(body, 0).join("\n") + "\n";
}

function ind(n: number): string { return INDENT.repeat(n); }
function printBlock(stmts: Stmt[], depth: number): string[] { const out: string[] = []; for (const s of stmts) out.push(...printStmt(s, depth)); return out; }

function printStmt(s: Stmt, depth: number): string[] {
  const p = ind(depth);
  switch (s.kind) {
    case "comment": return [`${p}${s.text}`];
    case "local": return [`${p}local ${s.names.join(", ")}${s.init.length ? " = " + s.init.map((e) => printExpr(e)).join(", ") : ""}`];
    case "assign": return [`${p}${s.targets.map((e) => printExpr(e)).join(", ")} = ${s.values.map((e) => printExpr(e)).join(", ")}`];
    case "compoundAssign": return [`${p}${printExpr(s.target)} ${s.op}= ${printExpr(s.value)}`];
    case "callStmt": return [`${p}${printExpr(s.call)}`];
    case "return": return [`${p}return${s.values.length ? " " + s.values.map((e) => printExpr(e)).join(", ") : ""}`];
    case "break": return [`${p}break`];
    case "continue": return [`${p}continue`];
    case "doBlock": return [`${p}do`, ...printBlock(s.body, depth + 1), `${p}end`];
    case "if": { const out: string[] = []; s.branches.forEach((br, i) => { out.push(`${p}${i === 0 ? "if" : "elseif"} ${printExpr(br.cond)} then`); out.push(...printBlock(br.body, depth + 1)); }); if (s.elseBody) { out.push(`${p}else`); out.push(...printBlock(s.elseBody, depth + 1)); } out.push(`${p}end`); return out; }
    case "while": return [`${p}while ${printExpr(s.cond)} do`, ...printBlock(s.body, depth + 1), `${p}end`];
    case "repeat": return [`${p}repeat`, ...printBlock(s.body, depth + 1), `${p}until ${printExpr(s.cond)}`];
    case "numericFor": { const range = s.step ? `${printExpr(s.start)}, ${printExpr(s.stop)}, ${printExpr(s.step)}` : `${printExpr(s.start)}, ${printExpr(s.stop)}`; return [`${p}for ${s.varName} = ${range} do`, ...printBlock(s.body, depth + 1), `${p}end`]; }
    case "genericFor": return [`${p}for ${s.names.join(", ")} in ${s.exprs.map((e) => printExpr(e)).join(", ")} do`, ...printBlock(s.body, depth + 1), `${p}end`];
    case "localFunction": return [`${p}local function ${s.name}(${s.params.join(", ")}${s.isVararg ? (s.params.length ? ", ..." : "...") : ""})`, ...printBlock(s.body, depth + 1), `${p}end`];
  }
}

function needsParens(outer: Expr, inner: Expr, side: "l" | "r"): boolean {
  const prec: Record<string, number> = { or:1, and:2, "<":3, ">":3, "<=":3, ">=":3, "~=":3, "==":3, "..":4, "+":5, "-":5, "*":6, "/":6, "//":6, "%":6, unary:8, "^":9 };
  const opOf = (e: Expr): string | null => e.kind === "binop" ? e.op : e.kind === "and" ? "and" : e.kind === "or" ? "or" : e.kind === "unop" || e.kind === "not" ? "unary" : null;
  const outerOp = opOf(outer), innerOp = opOf(inner); if (!outerOp || !innerOp) return false;
  const po = prec[outerOp] ?? 10, pi = prec[innerOp] ?? 10; if (pi < po) return true; if (pi === po && side === "r" && outerOp !== "..") return outerOp !== "^"; return false;
}
function wrap(outer: Expr, inner: Expr, side: "l" | "r"): string { const s = printExpr(inner); return needsParens(outer, inner, side) ? `(${s})` : s; }
function isIdentLike(name: string): boolean { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name); }

export function printExpr(e: Expr): string {
  switch (e.kind) {
    case "nil": return "nil"; case "true": return "true"; case "false": return "false"; case "number": return formatNumber(e.value); case "string": return formatString(e.value); case "vararg": return "..."; case "vector": return `Vector3.new(${formatNumber(e.x)}, ${formatNumber(e.y)}, ${formatNumber(e.z)})`; case "identifier": return e.name; case "raw": return e.text; case "paren": return `(${printExpr(e.inner)})`;
    case "index": { const objStr = e.obj.kind === "call" || e.obj.kind === "methodcall" || e.obj.kind === "binop" ? `(${printExpr(e.obj)})` : printExpr(e.obj); if (e.dot && isIdentLike(e.dot)) return `${objStr}.${e.dot}`; return `${objStr}[${printExpr(e.key)}]`; }
    case "call": { const calleeStr = e.callee.kind === "function" ? `(${printExpr(e.callee)})` : printExpr(e.callee); return `${calleeStr}(${e.args.map((a) => printExpr(a)).join(", ")})`; }
    case "methodcall": return `${printExpr(e.obj)}:${e.method}(${e.args.map((a) => printExpr(a)).join(", ")})`;
    case "binop": return `${wrap(e, e.lhs, "l")} ${e.op} ${wrap(e, e.rhs, "r")}`;
    case "unop": return `${e.op}${wrap(e, e.operand, "r")}`;
    case "and": return `${wrap(e, e.lhs, "l")} and ${wrap(e, e.rhs, "r")}`;
    case "or": return `${wrap(e, e.lhs, "l")} or ${wrap(e, e.rhs, "r")}`;
    case "not": return `not ${wrap(e, e.operand, "r")}`;
    case "function": { const header = `function(${e.params.join(", ")}${e.isVararg ? (e.params.length ? ", ..." : "...") : ""})`; return [header, ...printBlock(e.body, 1), "end"].join("\n"); }
    case "table": return printTable(e.fields);
  }
}

function printTable(fields: TableField[]): string { if (fields.length === 0) return "{}"; const parts = fields.map((f) => f.kind === "positional" ? printExpr(f.value) : f.kind === "named" ? `${f.name} = ${printExpr(f.value)}` : `[${printExpr(f.key)}] = ${printExpr(f.value)}`); return `{ ${parts.join(", ")} }`; }
function formatNumber(n: number): string { if (Number.isNaN(n)) return "(0/0)"; if (n === Infinity) return "math.huge"; if (n === -Infinity) return "-math.huge"; return n.toString(); }
function formatString(s: string): string { let out = '"'; for (const ch of s) { const code = ch.codePointAt(0)!; if (ch === '"') out += '\\"'; else if (ch === "\\") out += "\\\\"; else if (ch === "\n") out += "\\n"; else if (ch === "\r") out += "\\r"; else if (ch === "\t") out += "\\t"; else if (code < 0x20 || code === 0x7f) out += "\\" + code; else out += ch; } return out + '"'; }
