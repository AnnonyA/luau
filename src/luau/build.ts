// Per-basic-block expression/statement reconstruction.
//
// This is where SSA-lite folding decisions (ssa.ts) actually change the
// emitted AST: single-use, non-interfering definitions are inlined as
// expressions; anything else is materialized as a real local so evaluation
// order and repeated use are preserved exactly (see spec section 7 - folding
// must never duplicate or reorder effects).
import type { CFG, BasicBlock } from "./cfg";
import { effectClass, usedRegisters, definedRegisters, type RegDataflow } from "./ssa";
import type { ConstantValue, DecodedInstruction, DecodedProto } from "./types";
import type { Expr, Stmt, TableField } from "./ast";
import { normalizeFastcalls, type FastcallInfo } from "./fastcall";
import { collectEvidence, inferName, sanitizeIdentifier, type RegisterEvidence } from "./naming";

export type BlockExit =
  | { kind: "fallthrough" }
  | { kind: "jump" }
  | { kind: "return"; values: Expr[] }
  | { kind: "cond"; cond: Expr }
  | { kind: "fornum"; startExpr: Expr; stopExpr: Expr; stepExpr: Expr; varName: string; indexReg: number }
  | { kind: "forgen"; exprs: Expr[]; names: string[] };

export interface BlockRecovery { stmts: Stmt[]; exit: BlockExit; }
export interface NameInfo { name: string; confidence: string; evidence: string; }
export interface FunctionRecovery { blocks: Map<number, BlockRecovery>; registerNames: Map<number, NameInfo>; params: string[]; usedNames: Set<string>; }
interface PendingValue { expr: Expr; used: boolean; impure: boolean; }

const BINOPS: Record<string, string> = { ADD:"+",SUB:"-",MUL:"*",DIV:"/",MOD:"%",POW:"^",IDIV:"//",ADDK:"+",SUBK:"-",MULK:"*",DIVK:"/",MODK:"%",POWK:"^",IDIVK:"//",SUBRK:"-",DIVRK:"/",CONCAT:".." };

export function buildFunctionRecovery(proto: DecodedProto, cfg: CFG, dataflow: RegDataflow, resolveClosure: (protoId:number)=>Expr = (id)=>({kind:"raw",text:`<closure proto ${id}>`})): FunctionRecovery {
  const fastcalls=normalizeFastcalls(proto), evidence=collectEvidence(proto), registerNames=new Map<number,NameInfo>(), usedNames=new Set<string>();
  const nameForRegister=(reg:number):string=>{const existing=registerNames.get(reg);if(existing)return existing.name;const ev:RegisterEvidence=evidence.get(reg)??{},cand=inferName(ev,`v${reg}`);let name=sanitizeIdentifier(cand.name),n=2,base=name;while(usedNames.has(name))name=`${base}${n++}`;usedNames.add(name);registerNames.set(reg,{name,confidence:cand.confidence,evidence:cand.evidence});return name;};
  const params:string[]=[];for(let i=0;i<proto.numParams;i++)params.push(nameForRegister(i));
  const declaredRegisters=new Set<number>(),blocks=new Map<number,BlockRecovery>();
  for(const block of cfg.blocks)if(cfg.reachable.has(block.id))blocks.set(block.id,recoverBlock(block,proto,cfg,dataflow,fastcalls,nameForRegister,declaredRegisters,resolveClosure));
  return{blocks,registerNames,params,usedNames};
}

function constExpr(c:ConstantValue):Expr{switch(c.tag){case"nil":return{kind:"nil"};case"boolean":return c.boolean?{kind:"true"}:{kind:"false"};case"number":return{kind:"number",value:c.number??0};case"string":return{kind:"string",value:c.string??""};case"vector":return c.vector?{kind:"vector",x:c.vector[0],y:c.vector[1],z:c.vector[2],w:c.vector[3]}:{kind:"nil"};case"import":return{kind:"raw",text:c.importPath??"<import>"};default:return{kind:"raw",text:`--[[unsupported constant: ${c.tag}]]`};}}

function recoverBlock(block:BasicBlock,proto:DecodedProto,cfg:CFG,dataflow:RegDataflow,fastcalls:Map<number,FastcallInfo>,nameForRegister:(reg:number)=>string,declaredRegisters:Set<number>,resolveClosure:(protoId:number)=>Expr):BlockRecovery{
  const stmts:Stmt[]=[],pending=new Map<number,PendingValue>(),pendingNamecall=new Map<number,{obj:Expr;method:string}>(),liveOut=dataflow.liveOut[block.id]??new Set<number>();
  const isSingleUseWithin=(fromIdx:number,reg:number)=>{let count=0,sawEffect=false,firstUseIsAdjacent=true,seenAny=false;for(let j=fromIdx;j<block.instructions.length;j++){const ins=block.instructions[j];if(usedRegs(ins).includes(reg)){count++;if(!seenAny)firstUseIsAdjacent=!sawEffect;seenAny=true;}if(definedRegs(ins).includes(reg))break;if(effectClass(ins)!=="pure")sawEffect=true;}return{count,nextEffectBefore:!firstUseIsAdjacent};};
  const readReg=(reg:number):Expr=>{const p=pending.get(reg);if(p&&!p.used){p.used=true;pending.delete(reg);return p.expr;}return{kind:"identifier",name:nameForRegister(reg)};};
  const materialize=(reg:number,expr:Expr)=>{const name=nameForRegister(reg);if(declaredRegisters.has(reg))stmts.push({kind:"assign",targets:[{kind:"identifier",name}],values:[expr]});else{declaredRegisters.add(reg);stmts.push({kind:"local",names:[name],init:[expr]});}};
  const emitFlushIfEffectful=()=>{for(const[reg,p]of[...pending.entries()])if(!p.used&&p.impure){materialize(reg,p.expr);pending.delete(reg);}};
  const buildBinary=(ins:DecodedInstruction,lhs:Expr,rhs:Expr):Expr=>({kind:"binop",op:BINOPS[ins.opname],lhs,rhs});

  for(let idx=0;idx<block.instructions.length;idx++){
    const ins=block.instructions[idx],op=ins.opname;
    if(fastcalls.has(ins.pc))continue;
    const normalizedCall=[...fastcalls.values()].find((f)=>f.callInsPc===ins.pc);
    switch(op){
      case"NOP":case"BREAK":case"COVERAGE":case"CAPTURE":case"PREPVARARGS":case"CLOSEUPVALS":break;
      case"LOADNIL":setValue(ins.A,{kind:"nil"},false);break;
      case"LOADB":setValue(ins.A,ins.B?{kind:"true"}:{kind:"false"},false);break;
      case"LOADN":setValue(ins.A,{kind:"number",value:ins.D},false);break;
      case"LOADK":case"LOADKX":{const cidx=op==="LOADK"?ins.D:(ins.aux??0),c=proto.constants[cidx];setValue(ins.A,c?constExpr(c):{kind:"nil"},false);break;}
      case"MOVE":setValue(ins.A,readReg(ins.B),false);break;
      case"GETGLOBAL":{const c=proto.constants[ins.aux??0],name=c&&c.tag==="string"?c.string!:"_G";setValue(ins.A,{kind:"identifier",name},true);break;}
      case"SETGLOBAL":{const c=proto.constants[ins.aux??0],name=c&&c.tag==="string"?c.string!:"_G";emitFlushIfEffectful();stmts.push({kind:"assign",targets:[{kind:"identifier",name}],values:[readReg(ins.A)]});break;}
      case"GETUPVAL":{const upName=proto.upvalueNames[ins.B]?.name;setValue(ins.A,{kind:"identifier",name:upName?sanitizeIdentifier(upName):`upval${ins.B}`},false);break;}
      case"SETUPVAL":{const upName=proto.upvalueNames[ins.B]?.name;emitFlushIfEffectful();stmts.push({kind:"assign",targets:[{kind:"identifier",name:upName?sanitizeIdentifier(upName):`upval${ins.B}`}],values:[readReg(ins.A)]});break;}
      case"GETIMPORT":{const c=proto.constants[ins.D],path=c&&c.tag==="import"?c.importPath??"<import>":"<import>";setValue(ins.A,pathToExpr(path),true);break;}
      case"GETTABLE":setValue(ins.A,{kind:"index",obj:readReg(ins.B),key:readReg(ins.C)},true);break;
      case"GETTABLEN":setValue(ins.A,{kind:"index",obj:readReg(ins.B),key:{kind:"number",value:ins.C+1}},true);break;
      case"GETTABLEKS":{const c=proto.constants[ins.aux??0],key=c&&c.tag==="string"?c.string!:`k${ins.aux}`;setValue(ins.A,{kind:"index",obj:readReg(ins.B),key:{kind:"string",value:key},dot:key},true);break;}
      case"SETTABLE":emitFlushIfEffectful();stmts.push({kind:"assign",targets:[{kind:"index",obj:readReg(ins.A),key:readReg(ins.C)}],values:[readReg(ins.B)]});break;
      case"SETTABLEN":emitFlushIfEffectful();stmts.push({kind:"assign",targets:[{kind:"index",obj:readReg(ins.A),key:{kind:"number",value:ins.C+1}}],values:[readReg(ins.B)]});break;
      case"SETTABLEKS":{const c=proto.constants[ins.aux??0],key=c&&c.tag==="string"?c.string!:`k${ins.aux}`;emitFlushIfEffectful();stmts.push({kind:"assign",targets:[{kind:"index",obj:readReg(ins.A),key:{kind:"string",value:key},dot:key}],values:[readReg(ins.B)]});break;}
      case"NEWTABLE":case"DUPTABLE":{const fields:TableField[]=[];setValue(ins.A,{kind:"table",fields},false);break;}
      case"SETLIST":{const tableExpr=pending.get(ins.A),count=ins.C===0?undefined:ins.C-1,startReg=ins.B,values:Expr[]=[];if(count!==undefined)for(let i=0;i<count;i++)values.push(readReg(startReg+i));if(tableExpr&&tableExpr.expr.kind==="table"&&!tableExpr.used)for(const v of values)tableExpr.expr.fields.push({kind:"positional",value:v});else{emitFlushIfEffectful();const obj=readReg(ins.A);stmts.push({kind:"callStmt",call:{kind:"raw",text:"--[[SETLIST target could not be folded into a table constructor]]"}});for(let i=0;i<values.length;i++)stmts.push({kind:"assign",targets:[{kind:"index",obj,key:{kind:"number",value:(ins.aux??0)+i+1}}],values:[values[i]]});}break;}
      case"NEWCLOSURE":{const childId=proto.childProtoIds[ins.D]??ins.D;setValue(ins.A,resolveClosure(childId),false);break;}
      case"DUPCLOSURE":{const c=proto.constants[ins.D],childId=c&&c.tag==="closure"?c.closureProtoId??ins.D:ins.D;setValue(ins.A,resolveClosure(childId),false);break;}
      case"NOT":setValue(ins.A,{kind:"not",operand:readReg(ins.B)},false);break;
      case"MINUS":setValue(ins.A,{kind:"unop",op:"-",operand:readReg(ins.B)},true);break;
      case"LENGTH":setValue(ins.A,{kind:"unop",op:"#",operand:readReg(ins.B)},true);break;
      case"AND":setValue(ins.A,{kind:"and",lhs:readReg(ins.B),rhs:readReg(ins.C)},false);break;
      case"OR":setValue(ins.A,{kind:"or",lhs:readReg(ins.B),rhs:readReg(ins.C)},false);break;
      case"ANDK":setValue(ins.A,{kind:"and",lhs:readReg(ins.B),rhs:constOrRaw(proto,ins.C)},false);break;
      case"ORK":setValue(ins.A,{kind:"or",lhs:readReg(ins.B),rhs:constOrRaw(proto,ins.C)},false);break;
      case"ADD":case"SUB":case"MUL":case"DIV":case"MOD":case"POW":case"IDIV":setValue(ins.A,buildBinary(ins,readReg(ins.B),readReg(ins.C)),true);break;
      case"ADDK":case"SUBK":case"MULK":case"DIVK":case"MODK":case"POWK":case"IDIVK":setValue(ins.A,buildBinary(ins,readReg(ins.B),constOrRaw(proto,ins.C)),true);break;
      case"SUBRK":setValue(ins.A,{kind:"binop",op:"-",lhs:constOrRaw(proto,ins.B),rhs:readReg(ins.C)},true);break;
      case"DIVRK":setValue(ins.A,{kind:"binop",op:"/",lhs:constOrRaw(proto,ins.B),rhs:readReg(ins.C)},true);break;
      case"CONCAT":{let e:Expr|null=null;for(let r=ins.B;r<=ins.C;r++){const v=readReg(r);e=e?{kind:"binop",op:"..",lhs:e,rhs:v}:v;}setValue(ins.A,e??{kind:"string",value:""},true);break;}
      case"GETVARARGS":setValue(ins.A,{kind:"vararg"},false);break;
      case"NAMECALL":{const c=proto.constants[ins.aux??0],method=c&&c.tag==="string"?c.string!:`method${ins.aux}`;pendingNamecall.set(ins.A,{obj:readReg(ins.B),method});break;}
      case"CALL":{const nc=pendingNamecall.get(ins.A);pendingNamecall.delete(ins.A);const nargs=ins.B===0?liveArgsMultret(ins.A):ins.B-1,args:Expr[]=[];for(let i=0;i<nargs;i++)args.push(readReg(ins.A+1+i));emitFlushIfEffectful();let callExpr:Expr;if(normalizedCall&&normalizedCall.builtinName)callExpr={kind:"call",callee:pathToExpr(normalizedCall.builtinName),args,multret:ins.C===0};else if(nc)callExpr={kind:"methodcall",obj:nc.obj,method:nc.method,args,multret:ins.C===0};else callExpr={kind:"call",callee:readReg(ins.A),args,multret:ins.C===0};const nres=ins.C===0?1:ins.C-1;if(nres===0)stmts.push({kind:"callStmt",call:callExpr});else if(nres===1)setValue(ins.A,callExpr,true);else{const names:string[]=[];for(let i=0;i<nres;i++)names.push(nameForRegister(ins.A+i));const freshNames=names.map((n,i)=>{if(declaredRegisters.has(ins.A+i))return null;declaredRegisters.add(ins.A+i);return n;});if(freshNames.every((n)=>n!==null))stmts.push({kind:"local",names,init:[callExpr]});else{stmts.push({kind:"local",names:[`__mret${ins.A}`],init:[]});stmts.push({kind:"assign",targets:names.map((n)=>({kind:"identifier",name:n} as Expr)),values:[callExpr]});}for(let i=0;i<nres;i++)pending.delete(ins.A+i);}break;}
      case"RETURN":case"JUMP":case"JUMPBACK":case"JUMPX":case"JUMPIF":case"JUMPIFNOT":case"JUMPIFEQ":case"JUMPIFLE":case"JUMPIFLT":case"JUMPIFNOTEQ":case"JUMPIFNOTLE":case"JUMPIFNOTLT":case"JUMPXEQKNIL":case"JUMPXEQKB":case"JUMPXEQKN":case"JUMPXEQKS":case"FORNPREP":case"FORNLOOP":case"FORGPREP":case"FORGLOOP":case"DEP_FORGPREP_NEXT":case"DEP_FORGPREP_INEXT":case"DEP_FORGLOOP_NEXT":case"DEP_FORGLOOP_INEXT":break;
      case"FASTCALL":case"FASTCALL1":case"FASTCALL2":case"FASTCALL2K":case"FASTCALL3":break;
      default:stmts.push({kind:"comment",text:`unhandled opcode ${op} at pc ${ins.pc}`});
    }
    function setValue(reg:number,expr:Expr,impure:boolean){const prev=pending.get(reg);if(prev&&!prev.used)materialize(reg,prev.expr);const{count}=isSingleUseWithin(idx+1,reg),crossesBlock=liveOut.has(reg);if(!crossesBlock&&count===1)pending.set(reg,{expr,used:false,impure});else if(!crossesBlock&&count===0){if(impure)stmts.push({kind:"callStmt",call:expr});}else materialize(reg,expr);}
  }
  function liveArgsMultret(base:number):number{let n=0;while(pending.has(base+1+n))n++;return Math.max(n,0);}
  const term=block.instructions[block.instructions.length-1],exit=buildExit(term,proto,block,cfg,readReg,nameForRegister,declaredRegisters,stmts);return{stmts,exit};
}

function constOrRaw(proto:DecodedProto,cidx:number):Expr{const c=proto.constants[cidx];return c?constExpr(c):{kind:"raw",text:`k${cidx}`};}
function pathToExpr(path:string):Expr{const parts=path.split(".");let e:Expr={kind:"identifier",name:parts[0]};for(const part of parts.slice(1))e={kind:"index",obj:e,key:{kind:"string",value:part},dot:part};return e;}
function usedRegs(ins:DecodedInstruction){return usedRegisters(ins);}function definedRegs(ins:DecodedInstruction){return definedRegisters(ins);}
function buildExit(term:DecodedInstruction|undefined,proto:DecodedProto,block:BasicBlock,_cfg:CFG,readReg:(r:number)=>Expr,nameForRegister:(r:number)=>string,_declaredRegisters:Set<number>,_stmts:Stmt[]):BlockExit{
 if(!term)return{kind:"fallthrough"};switch(term.opname){case"RETURN":{const n=term.B===0?1:term.B-1,values:Expr[]=[];for(let i=0;i<n;i++)values.push(readReg(term.A+i));return{kind:"return",values};}case"JUMP":case"JUMPBACK":case"JUMPX":return{kind:"jump"};case"JUMPIF":return{kind:"cond",cond:readReg(term.A)};case"JUMPIFNOT":return{kind:"cond",cond:{kind:"not",operand:readReg(term.A)}};case"JUMPIFEQ":return{kind:"cond",cond:{kind:"binop",op:"==",lhs:readReg(term.A),rhs:readReg(term.aux??0)}};case"JUMPIFNOTEQ":return{kind:"cond",cond:{kind:"binop",op:"~=",lhs:readReg(term.A),rhs:readReg(term.aux??0)}};case"JUMPIFLE":return{kind:"cond",cond:{kind:"binop",op:"<=",lhs:readReg(term.A),rhs:readReg(term.aux??0)}};case"JUMPIFLT":return{kind:"cond",cond:{kind:"binop",op:"<",lhs:readReg(term.A),rhs:readReg(term.aux??0)}};case"JUMPIFNOTLE":return{kind:"cond",cond:{kind:"unop",op:"not",operand:{kind:"binop",op:"<=",lhs:readReg(term.A),rhs:readReg(term.aux??0)}}};case"JUMPIFNOTLT":return{kind:"cond",cond:{kind:"unop",op:"not",operand:{kind:"binop",op:"<",lhs:readReg(term.A),rhs:readReg(term.aux??0)}}};case"JUMPXEQKNIL":{const invert=((term.aux??0)&0x80000000)!==0,cmp:Expr={kind:"binop",op:"==",lhs:readReg(term.A),rhs:{kind:"nil"}};return{kind:"cond",cond:invert?{kind:"not",operand:cmp}:cmp};}case"JUMPXEQKB":{const invert=((term.aux??0)&0x80000000)!==0,val=((term.aux??0)&1)!==0,cmp:Expr={kind:"binop",op:"==",lhs:readReg(term.A),rhs:val?{kind:"true"}:{kind:"false"}};return{kind:"cond",cond:invert?{kind:"not",operand:cmp}:cmp};}case"JUMPXEQKN":case"JUMPXEQKS":{const invert=((term.aux??0)&0x80000000)!==0,cidx=(term.aux??0)&0x7fffffff,c=proto.constants[cidx],cmp:Expr={kind:"binop",op:"==",lhs:readReg(term.A),rhs:c?constExpr(c):{kind:"raw",text:`k${cidx}`}};return{kind:"cond",cond:invert?{kind:"not",operand:cmp}:cmp};}case"FORNPREP":{const base=term.A,startExpr=readReg(base),stopExpr=readReg(base+1),stepExpr=readReg(base+2),varReg=base+3<=254?base+3:base;return{kind:"fornum",startExpr,stopExpr,stepExpr,varName:nameForRegister(varReg),indexReg:varReg};}case"FORNLOOP":return{kind:"jump"};case"FORGPREP":case"DEP_FORGPREP_NEXT":case"DEP_FORGPREP_INEXT":{const base=term.A;return{kind:"forgen",exprs:[readReg(base),readReg(base+1),readReg(base+2)],names:[nameForRegister(base+3),nameForRegister(base+4)]};}case"FORGLOOP":case"DEP_FORGLOOP_NEXT":case"DEP_FORGLOOP_INEXT":return{kind:"jump"};default:return block.succs.length<=1?{kind:"fallthrough"}:{kind:"jump"};}
}
