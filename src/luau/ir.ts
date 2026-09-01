// Canonical VM IR helpers: classify decoded instructions by their control-
// flow and data-flow role so later stages (CFG, SSA, structuring, expression
// reconstruction) operate on semantics, not opcode mnemonics scattered
// throughout the codebase.
import type { DecodedInstruction, DecodedProto } from "./types";

export type BranchKind =
  | "none"
  | "jump" // unconditional
  | "cond2" // two successors: fallthrough + taken (JUMPIF family, JUMPXEQK family)
  | "fornprep" // numeric for loop init (jumps to loop end check)
  | "fornloop" // numeric for loop back-edge/exit
  | "forgprep" // generic for loop init
  | "forgloop" // generic for loop back-edge/exit
  | "return"
  | "fastcall-guard"; // FASTCALL* - C is a jump offset used to skip the fallback path

const JUMP_UNCONDITIONAL = new Set(["JUMP", "JUMPBACK", "JUMPX"]);
const JUMP_COND = new Set([
  "JUMPIF",
  "JUMPIFNOT",
  "JUMPIFEQ",
  "JUMPIFLE",
  "JUMPIFLT",
  "JUMPIFNOTEQ",
  "JUMPIFNOTLE",
  "JUMPIFNOTLT",
  "JUMPXEQKNIL",
  "JUMPXEQKB",
  "JUMPXEQKN",
  "JUMPXEQKS",
]);

export function branchKind(ins: DecodedInstruction): BranchKind {
  if (ins.opname === "RETURN") return "return";
  if (ins.opname === "FORNPREP") return "fornprep";
  if (ins.opname === "FORNLOOP") return "fornloop";
  if (ins.opname === "FORGPREP" || ins.opname === "DEP_FORGPREP_NEXT" || ins.opname === "DEP_FORGPREP_INEXT") return "forgprep";
  if (ins.opname === "FORGLOOP" || ins.opname === "DEP_FORGLOOP_NEXT" || ins.opname === "DEP_FORGLOOP_INEXT") return "forgloop";
  if (JUMP_UNCONDITIONAL.has(ins.opname)) return "jump";
  if (JUMP_COND.has(ins.opname)) return "cond2";
  if (ins.opname.startsWith("FASTCALL")) return "fastcall-guard";
  return "none";
}

/** Word index (pc) immediately after this instruction (accounting for AUX). */
export function nextPc(ins: DecodedInstruction): number {
  return ins.pc + ins.size;
}

/**
 * Resolves the jump target word-index for instructions whose offset is
 * measured from the word *after* the instruction (and after its AUX word,
 * per Bytecode.h: "for jump instructions with AUX, the AUX word is included
 * as part of the jump offset").
 */
export function jumpTarget(ins: DecodedInstruction): number | null {
  const kind = branchKind(ins);
  switch (kind) {
    case "jump":
    case "cond2":
    case "fornprep":
    case "fornloop":
    case "forgprep":
    case "forgloop":
      return nextPc(ins) + (ins.mode === "E" ? ins.E : ins.D);
    case "fastcall-guard":
      return nextPc(ins) + ins.C;
    default:
      return null;
  }
}

export function isTerminator(ins: DecodedInstruction): boolean {
  const k = branchKind(ins);
  return k === "return" || k === "jump";
}

export function isCall(ins: DecodedInstruction): boolean {
  return ins.opname === "CALL" || ins.opname === "NAMECALL";
}

export function isMultretMarker(c: number): boolean {
  // Luau convention: B/C == 0 in CALL/RETURN and friends means "use however
  // many values are on the stack" (MULTRET), i.e. an open value pack.
  return c === 0;
}

export function protoLabel(proto: DecodedProto): string {
  return proto.debugName ? proto.debugName : `proto_${proto.id}`;
}
