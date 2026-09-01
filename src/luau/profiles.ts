// Immutable bytecode version profiles, normalizing each supported Luau
// bytecode version into shared canonical semantics.
import type { SupportStatus } from "./types";

export interface BytecodeProfile {
  readonly version: number;
  readonly status: SupportStatus;
  readonly summary: string;
  readonly typesVersionRange: readonly [number, number] | null;
  readonly evidence: string;
}

const RAW_PROFILES: BytecodeProfile[] = [
  { version: 0, status: "UNSUPPORTED", summary: "0 is not a real version byte; it is the sentinel Luau uses to signal a compile error string follows.", typesVersionRange: null, evidence: "luau_load: version 0 payload is an error message, not a chunk." },
  { version: 1, status: "DECODER_ONLY", summary: "Baseline open-source bytecode. Officially unsupported by current Luau runtime (retired after 0.521).", typesVersionRange: null, evidence: "Bytecode.h: 'Version 1: Baseline version for the open-source release. Supported until 0.521.'" },
  { version: 2, status: "DECODER_ONLY", summary: "Adds Proto::linedefined. Retired after 0.544.", typesVersionRange: null, evidence: "Bytecode.h: 'Version 2: Adds Proto::linedefined. Supported until 0.544.'" },
  { version: 3, status: "PARTIAL", summary: "Adds FORGPREP/JUMPXEQK*, enhanced FORGLOOP AUX encoding; removes FORGLOOP_NEXT/INEXT and JUMPIFEQK/JUMPIFNOTEQK.", typesVersionRange: null, evidence: "Bytecode.h version history, verified live." },
  { version: 4, status: "FULL", summary: "Adds Proto::flags, typeinfo, IDIV/IDIVK.", typesVersionRange: [1, 2], evidence: "Bytecode.h version history, verified live." },
  { version: 5, status: "FULL", summary: "Adds SUBRK/DIVRK and vector constants.", typesVersionRange: [1, 3], evidence: "Bytecode.h version history, verified live." },
  { version: 6, status: "FULL", summary: "Adds FASTCALL3.", typesVersionRange: [1, 3], evidence: "Bytecode.h version history, verified live." },
  { version: 7, status: "PARTIAL", summary: "Adds LBC_CONSTANT_TABLE_WITH_CONSTANTS for DUPTABLE with pre-filled constant values.", typesVersionRange: [1, 3], evidence: "Bytecode.h version history, verified live." },
  { version: 8, status: "PARTIAL", summary: "Adds LBC_CONSTANT_INTEGER (64-bit integer constants).", typesVersionRange: [1, 3], evidence: "Bytecode.h version history, verified live." },
  { version: 9, status: "PARTIAL", summary: "Adds atom-based userdata field access acceleration.", typesVersionRange: [1, 3], evidence: "Bytecode.h version history, verified live." },
  { version: 10, status: "EXPERIMENTAL", summary: "Adds LBC_CONSTANT_CLASS_SHAPE and NEWCLASSMEMBER for Luau Classes.", typesVersionRange: null, evidence: "Bytecode.h: 'Version 10: ... Experimental.'" },
  { version: 11, status: "EXPERIMENTAL", summary: "Adds CALLFB, CMPPROTO and feedback vector description.", typesVersionRange: null, evidence: "Bytecode.h version history." },
  { version: 12, status: "EXPERIMENTAL", summary: "Adds per-proto byte size prefix and serialized cost function.", typesVersionRange: null, evidence: "Bytecode.h version history." },
  { version: 13, status: "EXPERIMENTAL", summary: "Adds double-precision vector constants.", typesVersionRange: null, evidence: "Bytecode.h version history." },
  { version: 14, status: "UNSUPPORTED", summary: "Adds FASTPCALL and is currently supported upstream, but the complete v12-v14 serialized layout and semantics are not implemented here; fail closed until verified.", typesVersionRange: [1, 3], evidence: "Bytecode.h: 'Version 14: Adds FASTPCALL. Currently supported.'" },
  { version: 100, status: "UNSUPPORTED", summary: "WIP version reserved for in-progress NEWCLASS work.", typesVersionRange: null, evidence: "Bytecode.h WIP version history." },
];

export const PROFILES: ReadonlyMap<number, BytecodeProfile> = new Map(RAW_PROFILES.map((p) => [p.version, p]));

export function getProfile(version: number): BytecodeProfile | null {
  return PROFILES.get(version) ?? null;
}

export function isDecodable(status: SupportStatus): boolean {
  return status !== "UNSUPPORTED" && status !== "EXPERIMENTAL";
}

export const LBC_BYTECODE_MIN = 3;
export const LBC_BYTECODE_MAX = 9;
