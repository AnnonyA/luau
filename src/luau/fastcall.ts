// FASTCALL/FASTCALL1/FASTCALL2/FASTCALL2K/FASTCALL3 normalization.
//
// The Luau compiler always emits a fast-path guard followed by the real
// fallback call sequence (GETIMPORT/GETGLOBAL/GETTABLEKS + CALL) so the
// interpreter can skip the guard when it can service the builtin call
// directly. Source-level, both paths mean exactly one thing: a normal call
// to the builtin. We recover that by locating the fallback CALL at the
// guard's jump target and describing the call using real decoded operands
// (never guessing argument text) - if the fallback CALL can't be located
// confidently we simply don't normalize, and the (still fully correct)
// literal fallback sequence is decompiled as-is.
import { jumpTarget, nextPc } from "./ir";
import type { DecodedInstruction, DecodedProto } from "./types";
import { BUILTIN_FUNCTIONS } from "./opcodes";

export interface FastcallInfo {
  builtinId: number;
  builtinName: string | null;
  callInsPc: number; // pc of the fallback CALL this guard skips to just after
  fallbackSpan: [number, number]; // [start, end) pc range considered "elided"
}

export function normalizeFastcalls(proto: DecodedProto): Map<number, FastcallInfo> {
  const out = new Map<number, FastcallInfo>();
  const byPc = new Map<number, DecodedInstruction>();
  for (const ins of proto.instructions) byPc.set(ins.pc, ins);

  for (const ins of proto.instructions) {
    if (!ins.opname.startsWith("FASTCALL")) continue;
    const target = jumpTarget(ins);
    if (target === null) continue;
    // The fallback CALL is expected to end exactly at `target` (CALL is a
    // 1-word ABC instruction with no AUX).
    const callPc = target - 1;
    const callIns = byPc.get(callPc);
    if (!callIns || callIns.opname !== "CALL") continue; // pattern didn't match; leave literal fallback in place
    out.set(ins.pc, {
      builtinId: ins.A,
      builtinName: BUILTIN_FUNCTIONS[ins.A] ?? null,
      callInsPc: callPc,
      fallbackSpan: [nextPc(ins), target],
    });
  }
  return out;
}
