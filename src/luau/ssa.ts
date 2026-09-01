import type { CFG } from "./cfg";
import type { DecodedInstruction, DecodedProto } from "./types";

export type EffectClass = "pure" | "impure-read" | "effect";
const PURE_OPS = new Set(["NOP","LOADNIL","LOADB","LOADN","LOADK","LOADKX","MOVE","GETUPVAL","NOT","AND","ANDK","OR","ORK","NEWTABLE","DUPTABLE","DUPCLOSURE","NEWCLOSURE","GETVARARGS"]);
const EFFECT_OPS = new Set(["CALL","NAMECALL","SETGLOBAL","SETTABLE","SETTABLEKS","SETTABLEN","SETUPVAL","SETLIST","CLOSEUPVALS","FASTCALL","FASTCALL1","FASTCALL2","FASTCALL2K","FASTCALL3"]);
export function effectClass(ins:DecodedInstruction):EffectClass { if(EFFECT_OPS.has(ins.opname)) return "effect"; if(PURE_OPS.has(ins.opname)) return "pure"; return "impure-read"; }

export function definedRegisters(ins:DecodedInstruction):number[] {
  switch(ins.opname){
    case "LOADNIL":case "LOADB":case "LOADN":case "LOADK":case "LOADKX":case "MOVE":case "GETGLOBAL":case "GETUPVAL":case "GETIMPORT":case "GETTABLE":case "GETTABLEKS":case "GETTABLEN":case "NEWCLOSURE":case "DUPCLOSURE":case "NEWTABLE":case "DUPTABLE":case "NOT":case "MINUS":case "LENGTH":case "ADD":case "SUB":case "MUL":case "DIV":case "MOD":case "POW":case "ADDK":case "SUBK":case "MULK":case "DIVK":case "MODK":case "POWK":case "AND":case "OR":case "ANDK":case "ORK":case "CONCAT":case "IDIV":case "IDIVK":case "SUBRK":case "DIVRK": return [ins.A];
    case "CALL": { if(ins.C===0) return [ins.A]; const out:number[]=[]; for(let r=ins.A;r<=ins.A+ins.C-2;r++) out.push(r); return out; }
    case "NAMECALL": return [ins.A,ins.A+1];
    case "GETVARARGS": { if(ins.B===0) return [ins.A]; const out:number[]=[]; for(let r=ins.A;r<=ins.A+ins.B-2;r++) out.push(r); return out; }
    case "FASTCALL":case "FASTCALL1":case "FASTCALL2":case "FASTCALL2K":case "FASTCALL3": return [];
    default:return [];
  }
}

export function usedRegisters(ins:DecodedInstruction):number[] {
  switch(ins.opname){
    case "MOVE":case "NOT":case "MINUS":case "LENGTH":case "GETUPVAL": return ins.opname==="GETUPVAL"?[]:[ins.B];
    case "SETUPVAL": return [ins.A];
    case "GETTABLE": return [ins.B,ins.C];
    case "GETTABLEKS":case "GETTABLEN": return [ins.B];
    case "SETTABLE": return [ins.A,ins.B,ins.C];
    case "SETTABLEKS":case "SETTABLEN": return [ins.A,ins.B];
    case "SETGLOBAL": return [ins.A];
    case "ADD":case "SUB":case "MUL":case "DIV":case "MOD":case "POW":case "IDIV":case "AND":case "OR": return [ins.B,ins.C];
    case "ADDK":case "SUBK":case "MULK":case "DIVK":case "MODK":case "POWK":case "ANDK":case "ORK":case "IDIVK":case "SUBRK":case "DIVRK": return [ins.B];
    case "CONCAT": { const out:number[]=[]; for(let r=ins.B;r<=ins.C;r++) out.push(r); return out; }
    case "RETURN": { if(ins.B===0) return [ins.A]; const out:number[]=[]; for(let r=ins.A;r<=ins.A+ins.B-2;r++) out.push(r); return out; }
    case "CALL": { const out=[ins.A]; const nargs=ins.B===0?1:ins.B-1; for(let i=1;i<=nargs;i++) out.push(ins.A+i); return out; }
    case "NAMECALL": return [ins.A];
    case "SETLIST": return [ins.A,ins.B];
    case "JUMPIFEQ":case "JUMPIFLE":case "JUMPIFLT":case "JUMPIFNOTEQ":case "JUMPIFNOTLE":case "JUMPIFNOTLT": return [ins.A,ins.aux??0];
    case "JUMPIF":case "JUMPIFNOT":case "JUMPXEQKNIL":case "JUMPXEQKB":case "JUMPXEQKN":case "JUMPXEQKS": return [ins.A];
    case "CLOSEUPVALS": return [ins.A];
    default:return [];
  }
}

export interface RegDataflow { liveIn:Set<number>[]; liveOut:Set<number>[]; ambiguousAtEntry:Set<number>[]; }
export function analyzeRegisters(cfg:CFG,_proto:DecodedProto):RegDataflow {
  const n=cfg.blocks.length, liveIn:Set<number>[] = Array.from({length:n},()=>new Set<number>()), liveOut:Set<number>[] = Array.from({length:n},()=>new Set<number>()), blockUse:Set<number>[]=[], blockDef:Set<number>[]=[];
  for(const b of cfg.blocks){ const use=new Set<number>(), def=new Set<number>(); for(const ins of b.instructions){ for(const u of usedRegisters(ins)) if(!def.has(u)) use.add(u); for(const d of definedRegisters(ins)) def.add(d); } blockUse.push(use); blockDef.push(def); }
  let changed=true,guard=0; while(changed&&guard++<100000){ changed=false; for(let i=n-1;i>=0;i--){ if(!cfg.reachable.has(i)) continue; const b=cfg.blocks[i],out=new Set<number>(); for(const s of b.succs) for(const r of liveIn[s]) out.add(r); const before=liveOut[i].size; liveOut[i]=out; const newIn=new Set<number>(blockUse[i]); for(const r of out) if(!blockDef[i].has(r)) newIn.add(r); if(newIn.size!==liveIn[i].size||before!==out.size) changed=true; liveIn[i]=newIn; } }
  const definesReg=(blockId:number,reg:number)=>blockDef[blockId].has(reg), ambiguousAtEntry:Set<number>[] = Array.from({length:n},()=>new Set<number>());
  for(const b of cfg.blocks){ if(!cfg.reachable.has(b.id)||b.preds.length<2) continue; for(const reg of liveIn[b.id]){ const sources=new Set<number>(); for(const p of b.preds){ let cur=p; const seen=new Set<number>(); let found:number|"undefined"="undefined"; while(!seen.has(cur)){ seen.add(cur); if(definesReg(cur,reg)){found=cur;break;} if(cfg.blocks[cur].preds.length===0) break; cur=cfg.blocks[cur].preds[0]; } sources.add(typeof found==="number"?found:-1); } if(sources.size>1) ambiguousAtEntry[b.id].add(reg); } }
  return {liveIn,liveOut,ambiguousAtEntry};
}
