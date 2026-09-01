// Luau AST node definitions used by the printer. This is a real (if
// pragmatic) AST - statements and expressions are structured nodes, never
// raw strings assembled by hand (with the narrow exception of already-
// final literal text for numbers/strings, which the printer still escapes).

export type Expr =
  | { kind: "nil" }
  | { kind: "true" }
  | { kind: "false" }
  | { kind: "number"; value: number; text?: string }
  | { kind: "string"; value: string }
  | { kind: "vararg" }
  | { kind: "vector"; x: number; y: number; z: number; w: number }
  | { kind: "identifier"; name: string }
  | { kind: "index"; obj: Expr; key: Expr; dot?: string } // dot: property name if computed via constant string
  | { kind: "call"; callee: Expr; args: Expr[]; multret?: boolean }
  | { kind: "methodcall"; obj: Expr; method: string; args: Expr[]; multret?: boolean }
  | { kind: "binop"; op: string; lhs: Expr; rhs: Expr }
  | { kind: "unop"; op: string; operand: Expr }
  | { kind: "and"; lhs: Expr; rhs: Expr }
  | { kind: "or"; lhs: Expr; rhs: Expr }
  | { kind: "not"; operand: Expr }
  | { kind: "paren"; inner: Expr }
  | { kind: "function"; params: string[]; isVararg: boolean; body: Stmt[]; name?: string }
  | { kind: "table"; fields: TableField[] }
  | { kind: "raw"; text: string }; // last-resort escape hatch for unrecognized-but-preserved operand text; always labeled in diagnostics when used

export type TableField =
  | { kind: "positional"; value: Expr }
  | { kind: "named"; name: string; value: Expr }
  | { kind: "computed"; key: Expr; value: Expr };

export type Stmt =
  | { kind: "local"; names: string[]; init: Expr[] }
  | { kind: "assign"; targets: Expr[]; values: Expr[] }
  | { kind: "compoundAssign"; target: Expr; op: string; value: Expr }
  | { kind: "callStmt"; call: Expr }
  | { kind: "return"; values: Expr[] }
  | { kind: "break" }
  | { kind: "continue" }
  | { kind: "if"; branches: { cond: Expr; body: Stmt[] }[]; elseBody: Stmt[] | null }
  | { kind: "while"; cond: Expr; body: Stmt[] }
  | { kind: "repeat"; body: Stmt[]; cond: Expr }
  | { kind: "numericFor"; varName: string; start: Expr; stop: Expr; step: Expr | null; body: Stmt[] }
  | { kind: "genericFor"; names: string[]; exprs: Expr[]; body: Stmt[] }
  | { kind: "localFunction"; name: string; params: string[]; isVararg: boolean; body: Stmt[] }
  | { kind: "doBlock"; body: Stmt[] }
  | { kind: "comment"; text: string };

export function ident(name: string): Expr {
  return { kind: "identifier", name };
}
export function num(value: number): Expr {
  return { kind: "number", value };
}
export function str(value: string): Expr {
  return { kind: "string", value };
}
