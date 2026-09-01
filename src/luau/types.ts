// Canonical shared types for the Luau bytecode decompiler pipeline.
//
// This module intentionally avoids "fake" richness: every field here is either
// populated from data we actually decoded/derived, or explicitly left
// undefined/absent with a diagnostic explaining why.

export type Confidence = "EXACT" | "HIGH" | "MEDIUM" | "LOW" | "FALLBACK";

export type SupportStatus =
  | "FULL"
  | "PARTIAL"
  | "DECODER_ONLY"
  | "EXPERIMENTAL"
  | "UNSUPPORTED";

export type InstructionMode = "ABC" | "AD" | "E";

export interface OpcodeSpec {
  id: number;
  name: string;
  mode: InstructionMode;
  hasAux: boolean;
  confidence: Confidence;
  sinceVersion: number;
  removedInVersion?: number;
  deprecated?: boolean;
  notes?: string;
}

export interface DecodedInstruction {
  pc: number;
  op: number;
  opname: string;
  mode: InstructionMode;
  A: number;
  B: number;
  C: number;
  D: number;
  E: number;
  aux?: number;
  size: 1 | 2;
}

export type ConstantTag = "nil" | "boolean" | "number" | "string" | "import" | "table" | "closure" | "vector" | "unsupported";

export interface ConstantValue {
  tag: ConstantTag;
  boolean?: boolean;
  number?: number;
  string?: string;
  importIds?: number[];
  importPath?: string;
  tableKeys?: number[];
  closureProtoId?: number;
  vector?: [number, number, number, number];
  raw?: unknown;
}

export interface LocalVarDebug {
  nameConstant: string | null;
  startpc: number;
  endpc: number;
  register: number;
}

export interface UpvalDebug {
  name: string | null;
}

export interface ProtoTypeInfo {
  raw: Uint8Array;
  parsed: boolean;
}

export interface DecodedProto {
  id: number;
  maxStackSize: number;
  numParams: number;
  numUpvalues: number;
  isVararg: boolean;
  flags: number;
  linedefined: number;
  debugName: string | null;
  instructions: DecodedInstruction[];
  constants: ConstantValue[];
  childProtoIds: number[];
  lineInfo: number[] | null;
  locals: LocalVarDebug[];
  upvalueNames: UpvalDebug[];
  typeInfo: ProtoTypeInfo | null;
  captures: CaptureInfo[];
}

export type CaptureType = "VAL" | "REF" | "UPVAL";

export interface CaptureInfo {
  atPc: number;
  type: CaptureType;
  source: number;
}

export interface DecodedModule {
  bytecodeVersion: number;
  typesVersion: number | null;
  stringTable: string[];
  protos: DecodedProto[];
  mainProtoId: number;
  totalBytes: number;
  consumedBytes: number;
}

export interface Diagnostic {
  severity: "info" | "warning" | "error";
  stage: string;
  message: string;
  protoId?: number;
  pc?: number;
}

export interface DecodeLimits {
  maxInputBytes: number;
  maxProtos: number;
  maxInstructionsPerProto: number;
  maxConstantsPerProto: number;
  maxStringTableEntries: number;
  maxProtoDepth: number;
  maxAnalysisIterations: number;
}

export const DEFAULT_LIMITS: DecodeLimits = {
  maxInputBytes: 64 * 1024 * 1024,
  maxProtos: 200_000,
  maxInstructionsPerProto: 1_000_000,
  maxConstantsPerProto: 1_000_000,
  maxStringTableEntries: 1_000_000,
  maxProtoDepth: 400,
  maxAnalysisIterations: 200_000,
};
