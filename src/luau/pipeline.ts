// Top-level pipeline: the same functions here back the CLI-equivalent API,
// tests and the UI. Nothing downstream of decodeBytes() re-parses raw bytes.
import { decodeBytes } from "./decoder";
import { buildCFG, type CFG } from "./cfg";
import { analyzeRegisters } from "./ssa";
import { buildFunctionRecovery } from "./build";
import { structureFunction } from "./structure";
import { printChunk, printExpr } from "./printer";
import type { Expr, Stmt } from "./ast";
import { protoLabel, jumpTarget } from "./ir";
import type { DecodedModule, DecodedProto, DecodeLimits, Diagnostic } from "./types";
import { DEFAULT_LIMITS } from "./types";
import { getProfile } from "./profiles";
import { OPCODE_BY_ID } from "./opcodes";

export interface DecompileOptions { limits?: DecodeLimits; }
export interface ProtoReport { id:number; label:string; status:"FULL"|"PARTIAL"|"FAILED"; cfgBlocks:number; loops:number; registerNames:{register:number;name:string;confidence:string;evidence:string}[]; }
export interface DecompileResult { ok:boolean; source:string|null; module:DecodedModule|null; diagnostics:Diagnostic[]; protoReports:ProtoReport[]; }
export interface InspectResult { ok:boolean; module:DecodedModule|null; diagnostics:Diagnostic[]; versionProfile:ReturnType<typeof getProfile>; }
export interface DisassemblyLine { protoId:number; pc:number; text:string; }
export interface DisassembleResult { ok:boolean; lines:DisassemblyLine[]; diagnostics:Diagnostic[]; }

export function inspectBytecode(bytes:Uint8Array, options:DecompileOptions={}):InspectResult {
  const {module,diagnostics,ok}=decodeBytes(bytes,options.limits??DEFAULT_LIMITS);
  const version=module?.bytecodeVersion??(bytes.length>0?bytes[0]:-1);
  return {ok,module,diagnostics,versionProfile:getProfile(version)};
}

export function disassembleBytes(bytes:Uint8Array, options:DecompileOptions={}):DisassembleResult {
  const {module,diagnostics,ok}=decodeBytes(bytes,options.limits??DEFAULT_LIMITS);
  if(!ok||!module) return {ok:false,lines:[],diagnostics};
  const lines:DisassemblyLine[]=[];
  for(const proto of module.protos){
    lines.push({protoId:proto.id,pc:-1,text:`-- proto ${proto.id} (${protoLabel(proto)}) params=${proto.numParams} upvals=${proto.numUpvalues} vararg=${proto.isVararg} maxstack=${proto.maxStackSize}`});
    for(const ins of proto.instructions){
      const spec=OPCODE_BY_ID.get(ins.op), target=jumpTarget(ins);
      const parts=[`[${ins.pc}]`,ins.opname.padEnd(18),`A=${ins.A}`,`B=${ins.B}`,`C=${ins.C}`,ins.mode==="AD"?`D=${ins.D}`:"",ins.mode==="E"?`E=${ins.E}`:"",ins.aux!==undefined?`AUX=${ins.aux}`:"",target!==null?`-> ${target}`:"",spec?``:"(unknown opcode)"];
      lines.push({protoId:proto.id,pc:ins.pc,text:parts.filter(Boolean).join(" ")});
    }
  }
  return {ok:true,lines,diagnostics};
}

export function decompileBytes(bytes:Uint8Array, options:DecompileOptions={}):DecompileResult {
  const {module,diagnostics,ok}=decodeBytes(bytes,options.limits??DEFAULT_LIMITS);
  if(!ok||!module) return {ok:false,source:null,module:null,diagnostics,protoReports:[]};
  const profile=getProfile(module.bytecodeVersion), cache=new Map<number,Expr>(), cfgCache=new Map<number,CFG>(), reports:ProtoReport[]=[], depthGuard=new Set<number>();
  const lastRecovery=new Map<number,{params:string[]}>();

  function decompileProtoExpr(protoId:number):Expr {
    if(cache.has(protoId)) return cache.get(protoId)!;
    if(depthGuard.has(protoId)||depthGuard.size>1000){ diagnostics.push({severity:"error",stage:"closures",message:`refusing to recurse into proto ${protoId} (cyclic or too-deep closure graph)`}); return {kind:"raw",text:`--[[unresolvable closure ${protoId}]] function() end`}; }
    depthGuard.add(protoId);
    const proto=module!.protos[protoId];
    if(!proto){ diagnostics.push({severity:"error",stage:"closures",message:`closure references missing proto ${protoId}`}); depthGuard.delete(protoId); return {kind:"raw",text:"function() end"}; }
    const body=decompileProtoBody(proto), params:string[]=[]; const rec=lastRecovery.get(protoId); if(rec) params.push(...rec.params);
    const expr:Expr={kind:"function",params,isVararg:proto.isVararg,body}; cache.set(protoId,expr); depthGuard.delete(protoId); return expr;
  }

  function decompileProtoBody(proto:DecodedProto):Stmt[] {
    try {
      let cfg=cfgCache.get(proto.id); if(!cfg){cfg=buildCFG(proto);cfgCache.set(proto.id,cfg);}
      const dataflow=analyzeRegisters(cfg,proto);
      const recovery=buildFunctionRecovery(proto,cfg,dataflow,(childId)=>decompileProtoExpr(childId));
      lastRecovery.set(proto.id,{params:recovery.params});
      const stmts=structureFunction(cfg,recovery,diagnostics,protoLabel(proto));
      reports.push({id:proto.id,label:protoLabel(proto),status:"FULL",cfgBlocks:cfg.blocks.length,loops:cfg.loops.length,registerNames:[...recovery.registerNames.entries()].map(([register,info])=>({register,name:info.name,confidence:info.confidence,evidence:info.evidence}))});
      return stmts;
    } catch(e) {
      diagnostics.push({severity:"error",stage:"reconstruct",message:`proto ${proto.id} (${protoLabel(proto)}) failed to reconstruct: ${(e as Error).message}`,protoId:proto.id});
      reports.push({id:proto.id,label:protoLabel(proto),status:"FAILED",cfgBlocks:0,loops:0,registerNames:[]});
      return [{kind:"comment",text:`-- decompiler error in ${protoLabel(proto)}: ${(e as Error).message}`}];
    }
  }

  if(!profile||profile.status==="UNSUPPORTED") return {ok:false,source:null,module,diagnostics,protoReports:[]};
  const mainProto=module.protos[module.mainProtoId]; let source:string|null=null;
  if(profile.status==="EXPERIMENTAL") diagnostics.push({severity:"warning",stage:"pipeline",message:"bytecode version is EXPERIMENTAL upstream; refusing full decompilation, use disassembleBytes()/inspectBytecode() instead"});
  else { const mainBody=decompileProtoBody(mainProto); for(const p of module.protos) if(!cfgCache.has(p.id)) decompileProtoBody(p); source=printChunk(mainBody); }
  return {ok:source!==null,source,module,diagnostics,protoReports:reports};
}

export function formatExpr(e:Expr):string { return printExpr(e); }
