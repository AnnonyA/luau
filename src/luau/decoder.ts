// Header/Prototype decoder: binary Luau bytecode -> DecodedModule.
//
// This stage is deliberately conservative: it validates every length,
// index and jump target it can, and refuses (with a structured diagnostic)
// rather than guesses when it hits bytecode it cannot decode with
// confidence (e.g. constant tags newer than VECTOR, or bytecode versions
// marked EXPERIMENTAL/UNSUPPORTED upstream).
import { BufferOverrunError, LimitExceededError, Reader } from "./reader";
import { CAPTURE_TYPE, CONSTANT_TAG, MAX_KNOWN_OPCODE, OPCODE_BY_ID } from "./opcodes";
import { getProfile, isDecodable } from "./profiles";
import type {
  CaptureInfo,
  ConstantValue,
  DecodedInstruction,
  DecodedModule,
  DecodedProto,
  DecodeLimits,
  Diagnostic,
  LocalVarDebug,
} from "./types";
import { DEFAULT_LIMITS } from "./types";

export class DecodeError extends Error {
  constructor(message: string, public diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = "DecodeError";
  }
}

export interface DecodeResult {
  module: DecodedModule | null;
  diagnostics: Diagnostic[];
  ok: boolean;
}

function sign16(v: number): number {
  return (v << 16) >> 16;
}
function sign24(v: number): number {
  return (v << 8) >> 8;
}
function sign8(v: number): number {
  return (v << 24) >> 24;
}

function decodeInstructionWord(pc: number, word: number): Omit<DecodedInstruction, "aux" | "size"> {
  const op = word & 0xff;
  const A = (word >>> 8) & 0xff;
  const B = (word >>> 16) & 0xff;
  const C = (word >>> 24) & 0xff;
  const D = sign16((word >>> 16) & 0xffff);
  const E = sign24((word >>> 8) & 0xffffff);
  const spec = OPCODE_BY_ID.get(op);
  return {
    pc,
    op,
    opname: spec?.name ?? `UNKNOWN_${op}`,
    mode: spec?.mode ?? "ABC",
    A,
    B,
    C,
    D,
    E,
  };
}

export function decodeBytes(bytes: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): DecodeResult {
  const diagnostics: Diagnostic[] = [];
  const push = (severity: Diagnostic["severity"], stage: string, message: string, extra: Partial<Diagnostic> = {}) =>
    diagnostics.push({ severity, stage, message, ...extra });

  if (bytes.length === 0) {
    push("error", "format", "empty input");
    return { module: null, diagnostics, ok: false };
  }
  if (bytes.length > limits.maxInputBytes) {
    push("error", "format", `input exceeds configured size limit (${bytes.length} > ${limits.maxInputBytes})`);
    return { module: null, diagnostics, ok: false };
  }

  const r = new Reader(bytes);
  try {
    const version = r.u8("header.version");
    if (version === 0) {
      // version 0 is the "compile failed" sentinel: an error string follows.
      let message = "<unreadable>";
      try {
        message = r.string("header.errorMessage");
      } catch {
        /* best effort */
      }
      push("error", "format", `input is a compiler error payload, not bytecode: ${message}`);
      return { module: null, diagnostics, ok: false };
    }

    const profile = getProfile(version);
    if (!profile) {
      push("error", "version", `unrecognized bytecode version ${version}; refusing to guess semantics`);
      return { module: null, diagnostics, ok: false };
    }
    if (!isDecodable(profile.status)) {
      push("error", "version", `bytecode version ${version} is marked ${profile.status}: ${profile.summary}`);
      return { module: null, diagnostics, ok: false };
    }
    if (profile.status === "EXPERIMENTAL") {
      push("warning", "version", `bytecode version ${version} is EXPERIMENTAL upstream (${profile.summary}); output is disassembly-only, not decompiled`);
    } else if (profile.status === "DECODER_ONLY") {
      push("warning", "version", `bytecode version ${version} is DECODER_ONLY (${profile.summary}); semantic reconstruction is not guaranteed`);
    } else if (profile.status === "PARTIAL") {
      push("info", "version", `bytecode version ${version}: ${profile.summary}`);
    }

    let typesVersion: number | null = null;
    if (version >= 4) {
      typesVersion = r.u8("header.typesVersion");
    }

    // ---- global string table ----
    const stringCount = r.varUint("stringtable.count");
    if (stringCount > limits.maxStringTableEntries) throw new LimitExceededError("string table entries", stringCount, limits.maxStringTableEntries);
    const stringTable: string[] = new Array(stringCount);
    for (let i = 0; i < stringCount; i++) stringTable[i] = r.string("stringtable.entry");

    // ---- optional userdata type name remapping table (typesVersion >= 3) ----
    // Best-effort: gated defensively; failure here is reported but does not
    // necessarily invalidate the whole module since we re-validate global
    // stream consumption at the very end.
    if (version >= 5 && typesVersion !== null && typesVersion >= 3) {
      try {
        let index = r.u8("userdataRemap.index");
        let guard = 0;
        while (index !== 0) {
          r.string("userdataRemap.name");
          index = r.u8("userdataRemap.index");
          if (++guard > 256) break;
        }
      } catch (e) {
        push("warning", "header", `userdata type remapping table did not parse cleanly (${(e as Error).message}); results past this point may be unreliable`);
      }
    }

    const protoCount = r.varUint("protos.count");
    if (protoCount > limits.maxProtos) throw new LimitExceededError("proto count", protoCount, limits.maxProtos);

    const protos: DecodedProto[] = [];
    for (let protoId = 0; protoId < protoCount; protoId++) {
      protos.push(decodeProto(r, protoId, version, stringTable, limits, push));
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        return { module: null, diagnostics, ok: false };
      }
    }

    const mainProtoId = r.varUint("mainProto");
    if (mainProtoId >= protos.length) {
      push("error", "format", `main proto id ${mainProtoId} out of range (${protos.length} protos)`);
      return { module: null, diagnostics, ok: false };
    }

    for (const proto of protos) {
      for (const childProtoId of proto.childProtoIds) {
        if (childProtoId >= protos.length) {
          push(
            "error",
            "format",
            `child proto id ${childProtoId} in proto ${proto.id} out of range (${protos.length} protos)`,
            { protoId: proto.id },
          );
          return { module: null, diagnostics, ok: false };
        }
      }
    }

    if (!validateConstantReferences(protos, push)) {
      return { module: null, diagnostics, ok: false };
    }

    if (!validateInstructionConstantReferences(protos, push)) {
      return { module: null, diagnostics, ok: false };
    }

    if (!validateProtoGraph(protos, limits.maxProtoDepth, push)) {
      return { module: null, diagnostics, ok: false };
    }

    const consumedBytes = r.pos;
    if (consumedBytes !== bytes.length) {
      push(
        "warning",
        "format",
        `stream had ${bytes.length - consumedBytes} trailing byte(s) after the declared module content; decode result may be based on a mis-parsed section`,
      );
    }

    // resolve import constant paths now that every proto's constants (and
    // upstream string table) are available
    for (const p of protos) resolveImportPaths(p);

    const module: DecodedModule = {
      bytecodeVersion: version,
      typesVersion,
      stringTable,
      protos,
      mainProtoId,
      totalBytes: bytes.length,
      consumedBytes,
    };
    return { module, diagnostics, ok: true };
  } catch (e) {
    if (e instanceof BufferOverrunError || e instanceof LimitExceededError) {
      push("error", "format", e.message);
    } else {
      push("error", "format", `unexpected decode failure: ${(e as Error).message}`);
    }
    return { module: null, diagnostics, ok: false };
  }
}

function validateConstantReferences(
  protos: DecodedProto[],
  push: (severity: Diagnostic["severity"], stage: string, message: string, extra?: Partial<Diagnostic>) => void,
): boolean {
  for (const proto of protos) {
    for (let constantIndex = 0; constantIndex < proto.constants.length; constantIndex++) {
      const constant = proto.constants[constantIndex];

      if (constant.tag === "closure" && constant.closureProtoId !== undefined && constant.closureProtoId >= protos.length) {
        push(
          "error",
          "format",
          `closure constant ${constantIndex} in proto ${proto.id} references proto id ${constant.closureProtoId} out of range (${protos.length} protos)`,
          { protoId: proto.id },
        );
        return false;
      }

      if (constant.tag === "table" && constant.tableKeys) {
        for (const key of constant.tableKeys) {
          if (key >= proto.constants.length) {
            push(
              "error",
              "format",
              `table constant ${constantIndex} in proto ${proto.id} references constant key ${key} out of range (${proto.constants.length} constants)`,
              { protoId: proto.id },
            );
            return false;
          }
        }
      }

      if (constant.tag === "import" && constant.importIds) {
        for (const id of constant.importIds) {
          if (id >= proto.constants.length) {
            push(
              "error",
              "format",
              `import constant ${constantIndex} in proto ${proto.id} references constant id ${id} out of range (${proto.constants.length} constants)`,
              { protoId: proto.id },
            );
            return false;
          }
        }
      }
    }
  }

  return true;
}

function validateInstructionConstantReferences(
  protos: DecodedProto[],
  push: (severity: Diagnostic["severity"], stage: string, message: string, extra?: Partial<Diagnostic>) => void,
): boolean {
  for (const proto of protos) {
    for (const ins of proto.instructions) {
      let constantIndex: number | undefined;
      if (ins.opname === "LOADK" || ins.opname === "DUPTABLE") constantIndex = ins.D;
      else if (
        ins.opname === "LOADKX" ||
        ins.opname === "GETGLOBAL" ||
        ins.opname === "SETGLOBAL" ||
        ins.opname === "GETTABLEKS" ||
        ins.opname === "SETTABLEKS" ||
        ins.opname === "NAMECALL" ||
        ins.opname === "FASTCALL2K"
      ) constantIndex = ins.aux;

      if (constantIndex !== undefined && (constantIndex < 0 || constantIndex >= proto.constants.length)) {
        push(
          "error",
          "format",
          `${ins.opname} at pc ${ins.pc} in proto ${proto.id} references constant ${constantIndex} out of range (${proto.constants.length} constants)`,
          { protoId: proto.id, pc: ins.pc },
        );
        return false;
      }
    }
  }

  return true;
}

function validateProtoGraph(
  protos: DecodedProto[],
  maxDepth: number,
  push: (severity: Diagnostic["severity"], stage: string, message: string, extra?: Partial<Diagnostic>) => void,
): boolean {
  const state = new Uint8Array(protos.length);
  const longestDepth = new Uint32Array(protos.length);

  type Frame = { protoId: number; nextChild: number; maxChildDepth: number };

  for (let start = 0; start < protos.length; start++) {
    if (state[start] === 2) continue;

    const stack: Frame[] = [{ protoId: start, nextChild: 0, maxChildDepth: 0 }];
    state[start] = 1;

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const children = protos[frame.protoId].childProtoIds;

      if (frame.nextChild < children.length) {
        const childProtoId = children[frame.nextChild++];
        if (state[childProtoId] === 1) {
          push(
            "error",
            "format",
            `proto graph cycle detected from proto ${frame.protoId} to proto ${childProtoId}`,
            { protoId: frame.protoId },
          );
          return false;
        }
        if (state[childProtoId] === 2) {
          frame.maxChildDepth = Math.max(frame.maxChildDepth, longestDepth[childProtoId]);
          continue;
        }

        state[childProtoId] = 1;
        stack.push({ protoId: childProtoId, nextChild: 0, maxChildDepth: 0 });
        continue;
      }

      const depth = frame.maxChildDepth + 1;
      if (depth > maxDepth) {
        push(
          "error",
          "format",
          `proto depth ${depth} exceeds configured limit ${maxDepth} at proto ${frame.protoId}`,
          { protoId: frame.protoId },
        );
        return false;
      }

      longestDepth[frame.protoId] = depth;
      state[frame.protoId] = 2;
      stack.pop();
      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        parent.maxChildDepth = Math.max(parent.maxChildDepth, depth);
      }
    }
  }

  return true;
}

function decodeProto(
  r: Reader,
  protoId: number,
  version: number,
  stringTable: string[],
  limits: DecodeLimits,
  push: (severity: Diagnostic["severity"], stage: string, message: string, extra?: Partial<Diagnostic>) => void,
): DecodedProto {
  const maxStackSize = r.u8("proto.maxstacksize");
  const numParams = r.u8("proto.numparams");
  const numUpvalues = r.u8("proto.nups");
  const isVararg = r.bool("proto.isvararg");
  let flags = 0;
  let typeInfo: DecodedProto["typeInfo"] = null;
  if (version >= 4) {
    flags = r.u8("proto.flags");
    const typesize = r.varUint("proto.typeinfo.size");
    if (typesize > 0) {
      const raw = r.bytes_(typesize, "proto.typeinfo.data");
      typeInfo = { raw: new Uint8Array(raw), parsed: false };
    }
  }

  const sizecode = r.varUint("proto.sizecode");
  if (sizecode > limits.maxInstructionsPerProto) throw new LimitExceededError("instructions per proto", sizecode, limits.maxInstructionsPerProto);
  const words: number[] = new Array(sizecode);
  for (let i = 0; i < sizecode; i++) words[i] = r.u32("proto.code");

  const instructions: DecodedInstruction[] = [];
  for (let i = 0; i < sizecode; i++) {
    const pc = i;
    const base = decodeInstructionWord(pc, words[i]);
    const spec = OPCODE_BY_ID.get(base.op);
    if (base.op > MAX_KNOWN_OPCODE || !spec) {
      push("error", "decode", `unknown opcode ${base.op} at word ${i} in proto ${protoId}; cannot safely continue decoding this proto's instruction stream`, { protoId, pc: i });
      // Stop decoding instructions for this proto rather than risk
      // misinterpreting AUX word boundaries (which would desynchronize
      // everything after it).
      break;
    }
    if (spec.deprecated && spec.removedInVersion !== undefined && version >= spec.removedInVersion) {
      push("warning", "decode", `deprecated opcode ${spec.name} encountered in bytecode version ${version} (removed in ${spec.removedInVersion}); decoding operands but semantics are unverified`, { protoId, pc: i });
    }
    let aux: number | undefined;
    let size: 1 | 2 = 1;
    if (spec.hasAux) {
      i++;
      if (i >= sizecode) {
        push("error", "decode", `${spec.name} declares an AUX word but the instruction stream ended`, { protoId, pc: base.pc });
        break;
      }
      aux = words[i] >>> 0;
      size = 2;
    }
    instructions.push({ ...base, opname: spec.name, mode: spec.mode, aux, size });
  }

  const sizek = r.varUint("proto.sizek");
  if (sizek > limits.maxConstantsPerProto) throw new LimitExceededError("constants per proto", sizek, limits.maxConstantsPerProto);
  const constants: ConstantValue[] = new Array(sizek);
  for (let i = 0; i < sizek; i++) {
    constants[i] = decodeConstant(r, protoId, i, stringTable, version, push);
  }

  const sizep = r.varUint("proto.sizep");
  const childProtoIds: number[] = new Array(sizep);
  for (let i = 0; i < sizep; i++) childProtoIds[i] = r.varUint("proto.p");

  const linedefined = version >= 2 ? r.varUint("proto.linedefined") : 0;
  const debugNameIdx = r.varUint("proto.debugname");
  const debugName = debugNameIdx === 0 ? null : stringTable[debugNameIdx - 1] ?? null;

  let lineInfo: number[] | null = null;
  const hasLineInfo = r.bool("proto.hasLineInfo");
  if (hasLineInfo) {
    const linegaplog2 = r.u8("proto.linegaplog2");
    const deltas = new Int8Array(sizecode);
    for (let i = 0; i < sizecode; i++) deltas[i] = sign8(r.u8("proto.lineinfo.delta"));
    const intervals = sizecode === 0 ? 0 : ((sizecode - 1) >> linegaplog2) + 1;
    const abs = new Int32Array(intervals);
    for (let i = 0; i < intervals; i++) abs[i] = r.i32("proto.lineinfo.abs");
    lineInfo = new Array(sizecode);
    for (let i = 0; i < sizecode; i++) {
      const base = abs[i >> linegaplog2] ?? 0;
      lineInfo[i] = base + deltas[i];
    }
  }

  const sizelocvars = r.varUint("proto.sizelocvars");
  const locals: LocalVarDebug[] = new Array(sizelocvars);
  for (let i = 0; i < sizelocvars; i++) {
    const nameIdx = r.varUint("proto.local.name");
    const startpc = r.varUint("proto.local.startpc");
    const endpc = r.varUint("proto.local.endpc");
    const register = r.u8("proto.local.reg");
    locals[i] = { nameConstant: nameIdx === 0 ? null : stringTable[nameIdx - 1] ?? null, startpc, endpc, register };
  }

  const sizeupvalues = r.varUint("proto.sizeupvalues");
  const upvalueNames = new Array(sizeupvalues);
  for (let i = 0; i < sizeupvalues; i++) {
    const nameIdx = r.varUint("proto.upval.name");
    upvalueNames[i] = { name: nameIdx === 0 ? null : stringTable[nameIdx - 1] ?? null };
  }

  const captures = extractCaptures(instructions, protoId, push);

  return {
    id: protoId,
    maxStackSize,
    numParams,
    numUpvalues,
    isVararg,
    flags,
    linedefined,
    debugName,
    instructions,
    constants,
    childProtoIds,
    lineInfo,
    locals,
    upvalueNames,
    typeInfo,
    captures,
  };
}

function extractCaptures(
  instructions: DecodedInstruction[],
  protoId: number,
  push: (severity: Diagnostic["severity"], stage: string, message: string, extra?: Partial<Diagnostic>) => void,
): CaptureInfo[] {
  const out: CaptureInfo[] = [];
  for (const ins of instructions) {
    if (ins.opname !== "CAPTURE") continue;
    const type = CAPTURE_TYPE[ins.A];
    if (!type) {
      push("warning", "decode", `CAPTURE with unknown capture type tag ${ins.A}`, { protoId, pc: ins.pc });
      continue;
    }
    out.push({ atPc: ins.pc, type, source: ins.B });
  }
  return out;
}

function decodeConstant(
  r: Reader,
  protoId: number,
  index: number,
  stringTable: string[],
  version: number,
  push: (severity: Diagnostic["severity"], stage: string, message: string, extra?: Partial<Diagnostic>) => void,
): ConstantValue {
  const tag = r.u8("constant.tag");
  switch (tag) {
    case CONSTANT_TAG.NIL:
      return { tag: "nil" };
    case CONSTANT_TAG.BOOLEAN:
      return { tag: "boolean", boolean: r.bool("constant.boolean") };
    case CONSTANT_TAG.NUMBER:
      return { tag: "number", number: r.f64("constant.number") };
    case CONSTANT_TAG.STRING: {
      const sid = r.varUint("constant.string.id");
      if (sid === 0) {
        push("error", "decode", `string constant ${index} in proto ${protoId} uses reserved string id 0`, { protoId });
        throw new Error(`invalid string constant id 0 in proto ${protoId}`);
      }
      if (sid > stringTable.length) {
        push(
          "error",
          "decode",
          `string constant ${index} in proto ${protoId} references string id ${sid} out of range (${stringTable.length} strings)`,
          { protoId },
        );
        throw new Error(`string constant id ${sid} out of range in proto ${protoId}`);
      }
      return { tag: "string", string: stringTable[sid - 1] };
    }
    case CONSTANT_TAG.IMPORT: {
      const packed = r.u32("constant.import.id");
      const count = (packed >>> 30) & 0x3;
      if (count === 0) {
        push("error", "decode", `import constant ${index} in proto ${protoId} has invalid path length 0`, { protoId });
        throw new Error(`invalid import path length 0 in proto ${protoId}`);
      }
      const id0 = (packed >>> 20) & 0x3ff;
      const id1 = (packed >>> 10) & 0x3ff;
      const id2 = packed & 0x3ff;
      const ids = [id0, id1, id2].slice(0, count);
      return { tag: "import", importIds: ids, raw: packed };
    }
    case CONSTANT_TAG.TABLE: {
      const n = r.varUint("constant.table.len");
      const keys: number[] = new Array(n);
      for (let i = 0; i < n; i++) keys[i] = r.varUint("constant.table.key");
      return { tag: "table", tableKeys: keys };
    }
    case CONSTANT_TAG.CLOSURE:
      return { tag: "closure", closureProtoId: r.varUint("constant.closure.proto") };
    case CONSTANT_TAG.VECTOR: {
      const x = r.f32("constant.vector.x");
      const y = r.f32("constant.vector.y");
      const z = r.f32("constant.vector.z");
      const w = r.f32("constant.vector.w");
      return { tag: "vector", vector: [x, y, z, w] };
    }
    default:
      push("error", "decode", `constant tag ${tag} at index ${index} is not a supported tag (VECTOR=7 is the highest we decode); aborting proto ${protoId}'s constant table`, { protoId });
      throw new Error(`unsupported constant tag ${tag} (bytecode version ${version})`);
  }
}

function resolveImportPaths(proto: DecodedProto) {
  for (const c of proto.constants) {
    if (c.tag !== "import" || !c.importIds) continue;
    const parts: string[] = [];
    for (const cid of c.importIds) {
      const k = proto.constants[cid];
      if (k && k.tag === "string" && k.string !== undefined) parts.push(k.string);
      else parts.push(`<const ${cid}>`);
    }
    c.importPath = parts.join(".");
  }
}
