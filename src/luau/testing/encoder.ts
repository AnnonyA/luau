// Minimal Luau bytecode assembler used only to build regression-test fixtures.
// It is not the official Luau compiler; it exists to exercise the
// decoder/CFG/SSA/structuring/printer pipeline against controlled bytecode.
import { OPCODE_BY_NAME, CONSTANT_TAG } from "../opcodes";

export class ByteWriter {
  private chunks: number[] = [];
  u8(v: number) { this.chunks.push(v & 0xff); }
  bytes(bs: number[] | Uint8Array) { for (const b of bs) this.chunks.push(b & 0xff); }
  u32(v: number) { this.u8(v & 0xff); this.u8((v >>> 8) & 0xff); this.u8((v >>> 16) & 0xff); this.u8((v >>> 24) & 0xff); }
  i32(v: number) { this.u32(v >>> 0); }
  f32(v: number) { const buf = new ArrayBuffer(4); new DataView(buf).setFloat32(0, v, true); this.bytes(new Uint8Array(buf)); }
  f64(v: number) { const buf = new ArrayBuffer(8); new DataView(buf).setFloat64(0, v, true); this.bytes(new Uint8Array(buf)); }
  varUint(v: number) { let x = v >>> 0; for (;;) { if (x < 0x80) { this.u8(x); return; } this.u8((x & 0x7f) | 0x80); x >>>= 7; } }
  string(s: string) { const bytes = new TextEncoder().encode(s); this.varUint(bytes.length); this.bytes(bytes); }
  toBytes(): Uint8Array { return new Uint8Array(this.chunks); }
}

export type Operand = { A?: number; B?: number; C?: number; D?: number; E?: number; aux?: number };
export interface AsmInstr { op: string; A?: number; B?: number; C?: number; D?: number; E?: number; aux?: number; }

export function encodeInstruction(instr: AsmInstr): number[] {
  const spec = OPCODE_BY_NAME.get(instr.op);
  if (!spec) throw new Error(`unknown test opcode ${instr.op}`);
  let word = spec.id & 0xff;
  if (spec.mode === "ABC") { word |= ((instr.A ?? 0) & 0xff) << 8; word |= ((instr.B ?? 0) & 0xff) << 16; word |= ((instr.C ?? 0) & 0xff) << 24; }
  else if (spec.mode === "AD") { word |= ((instr.A ?? 0) & 0xff) << 8; word |= ((instr.D ?? 0) & 0xffff) << 16; }
  else word |= ((instr.E ?? 0) & 0xffffff) << 8;
  const words = [word >>> 0]; if (spec.hasAux) words.push((instr.aux ?? 0) >>> 0); return words;
}

export type AsmConstant =
  | { tag: "nil" }
  | { tag: "boolean"; value: boolean }
  | { tag: "number"; value: number }
  | { tag: "string"; value: string }
  | { tag: "import"; ids: number[] }
  | { tag: "table"; keys: number[] }
  | { tag: "closure"; proto: number }
  | { tag: "vector"; x: number; y: number; z: number; w: number };

export interface AsmProto { maxStackSize:number; numParams:number; numUpvalues:number; isVararg:boolean; instructions:AsmInstr[]; constants:AsmConstant[]; childProtoIds:number[]; debugName?:string; locals?:{name:string;startpc:number;endpc:number;register:number}[]; upvalueNames?:string[]; }
export interface AsmModule { version:number; typesVersion?:number; protos:AsmProto[]; mainProtoId:number; }

export function assembleModule(mod: AsmModule): Uint8Array {
  const w = new ByteWriter(); w.u8(mod.version); if (mod.version >= 4) w.u8(mod.typesVersion ?? 1);
  const strings:string[] = [], stringIndex = new Map<string,number>();
  const internString=(s:string):number=>{let i=stringIndex.get(s);if(i===undefined){i=strings.length;strings.push(s);stringIndex.set(s,i);}return i+1;};
  for(const p of mod.protos){for(const c of p.constants)if(c.tag==="string")internString(c.value);if(p.debugName)internString(p.debugName);for(const l of p.locals??[])internString(l.name);for(const u of p.upvalueNames??[])internString(u);}
  w.varUint(strings.length);for(const s of strings)w.string(s);
  w.varUint(mod.protos.length);for(const p of mod.protos)writeProto(w,p,mod.version,internString);
  w.varUint(mod.mainProtoId);return w.toBytes();
}

function writeProto(w:ByteWriter,p:AsmProto,version:number,internString:(s:string)=>number){
  w.u8(p.maxStackSize);w.u8(p.numParams);w.u8(p.numUpvalues);w.u8(p.isVararg?1:0);if(version>=4){w.u8(0);w.varUint(0);}
  const words:number[]=[];for(const ins of p.instructions)words.push(...encodeInstruction(ins));w.varUint(words.length);for(const word of words)w.u32(word);
  w.varUint(p.constants.length);for(const c of p.constants)writeConstant(w,c,internString);
  w.varUint(p.childProtoIds.length);for(const id of p.childProtoIds)w.varUint(id);
  if(version>=2)w.varUint(0);w.varUint(p.debugName?internString(p.debugName):0);w.u8(0);
  const locals=p.locals??[];w.varUint(locals.length);for(const l of locals){w.varUint(internString(l.name));w.varUint(l.startpc);w.varUint(l.endpc);w.u8(l.register);}
  const upvals=p.upvalueNames??[];w.varUint(upvals.length);for(const u of upvals)w.varUint(internString(u));
}

function writeConstant(w:ByteWriter,c:AsmConstant,internString:(s:string)=>number){switch(c.tag){case"nil":w.u8(CONSTANT_TAG.NIL);break;case"boolean":w.u8(CONSTANT_TAG.BOOLEAN);w.u8(c.value?1:0);break;case"number":w.u8(CONSTANT_TAG.NUMBER);w.f64(c.value);break;case"string":w.u8(CONSTANT_TAG.STRING);w.varUint(internString(c.value));break;case"import":{w.u8(CONSTANT_TAG.IMPORT);const count=Math.min(3,c.ids.length),id0=c.ids[0]??0,id1=c.ids[1]??0,id2=c.ids[2]??0,packed=((count&3)<<30)|((id0&0x3ff)<<20)|((id1&0x3ff)<<10)|(id2&0x3ff);w.u32(packed>>>0);break;}case"table":w.u8(CONSTANT_TAG.TABLE);w.varUint(c.keys.length);for(const k of c.keys)w.varUint(k);break;case"closure":w.u8(CONSTANT_TAG.CLOSURE);w.varUint(c.proto);break;case"vector":w.u8(CONSTANT_TAG.VECTOR);w.f32(c.x);w.f32(c.y);w.f32(c.z);w.f32(c.w);break;}}
