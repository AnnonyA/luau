// AST cleanup passes. Every transform here is semantics-preserving: no
// reordering, no duplication of potentially-effectful sub-expressions. Only
// algebraic identities on booleans/negation and dead double-negation removal
// are performed.
import type { Expr, Stmt } from "./ast";

const FLIP: Record<string, string> = {
  "==": "~=",
  "~=": "==",
  "<": ">=",
  "<=": ">",
  ">": "<=",
  ">=": "<",
};

export function simplifyExpr(e: Expr): Expr {
  switch (e.kind) {
    case "not": {
      const inner = simplifyExpr(e.operand);
      if (inner.kind === "not") return inner.operand;
      if (inner.kind === "binop" && FLIP[inner.op]) return { kind: "binop", op: FLIP[inner.op], lhs: inner.lhs, rhs: inner.rhs };
      if (inner.kind === "true") return { kind: "false" };
      if (inner.kind === "false") return { kind: "true" };
      return { kind: "not", operand: inner };
    }
    case "unop": {
      const inner = simplifyExpr(e.operand);
      if (e.op === "not") return simplifyExpr({ kind: "not", operand: inner });
      return { kind: "unop", op: e.op, operand: inner };
    }
    case "binop":
      return { kind: "binop", op: e.op, lhs: simplifyExpr(e.lhs), rhs: simplifyExpr(e.rhs) };
    case "and":
      return { kind: "and", lhs: simplifyExpr(e.lhs), rhs: simplifyExpr(e.rhs) };
    case "or":
      return { kind: "or", lhs: simplifyExpr(e.lhs), rhs: simplifyExpr(e.rhs) };
    case "paren":
      return { kind: "paren", inner: simplifyExpr(e.inner) };
    case "index":
      return { ...e, obj: simplifyExpr(e.obj), key: simplifyExpr(e.key) };
    case "call":
      return { ...e, callee: simplifyExpr(e.callee), args: e.args.map(simplifyExpr) };
    case "methodcall":
      return { ...e, obj: simplifyExpr(e.obj), args: e.args.map(simplifyExpr) };
    case "function":
      return { ...e, body: e.body.map(simplifyStmt) };
    case "table":
      return {
        ...e,
        fields: e.fields.map((f) =>
          f.kind === "positional"
            ? { ...f, value: simplifyExpr(f.value) }
            : f.kind === "named"
              ? { ...f, value: simplifyExpr(f.value) }
              : { kind: "computed" as const, key: simplifyExpr(f.key), value: simplifyExpr(f.value) },
        ),
      };
    default:
      return e;
  }
}

export function simplifyStmt(s: Stmt): Stmt {
  switch (s.kind) {
    case "local":
      return { ...s, init: s.init.map(simplifyExpr) };
    case "assign":
      return { ...s, targets: s.targets.map(simplifyExpr), values: s.values.map(simplifyExpr) };
    case "compoundAssign":
      return { ...s, target: simplifyExpr(s.target), value: simplifyExpr(s.value) };
    case "callStmt":
      return { ...s, call: simplifyExpr(s.call) };
    case "return":
      return { ...s, values: s.values.map(simplifyExpr) };
    case "if":
      return { ...s, branches: s.branches.map((b) => ({ cond: simplifyExpr(b.cond), body: b.body.map(simplifyStmt) })), elseBody: s.elseBody ? s.elseBody.map(simplifyStmt) : null };
    case "while":
      return { ...s, cond: simplifyExpr(s.cond), body: s.body.map(simplifyStmt) };
    case "repeat":
      return { ...s, cond: simplifyExpr(s.cond), body: s.body.map(simplifyStmt) };
    case "numericFor":
      return { ...s, start: simplifyExpr(s.start), stop: simplifyExpr(s.stop), step: s.step ? simplifyExpr(s.step) : null, body: s.body.map(simplifyStmt) };
    case "genericFor":
      return { ...s, exprs: s.exprs.map(simplifyExpr), body: s.body.map(simplifyStmt) };
    case "localFunction":
      return { ...s, body: s.body.map(simplifyStmt) };
    case "doBlock":
      return { ...s, body: s.body.map(simplifyStmt) };
    default:
      return s;
  }
}

export function simplifyChunk(stmts: Stmt[]): Stmt[] {
  return stmts.map(simplifyStmt);
}
