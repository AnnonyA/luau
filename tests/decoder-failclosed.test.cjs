const assert = require("node:assert/strict");
const test = require("node:test");
const { decodeBytes } = require("../.test-build/src/luau/decoder.js");

function varUint(value) {
  const out = [];
  let x = value >>> 0;
  do {
    let b = x & 0x7f;
    x >>>= 7;
    if (x !== 0) b |= 0x80;
    out.push(b);
  } while (x !== 0);
  return out;
}

function u32le(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function moduleWithSingleWord(word) {
  return Uint8Array.from([
    4, 1,
    ...varUint(0),
    ...varUint(1),
    1, 0, 0, 0,
    0,
    ...varUint(0),
    ...varUint(1),
    ...u32le(word),
    ...varUint(0),
    ...varUint(0),
    ...varUint(0),
    ...varUint(0),
    0,
    ...varUint(0),
    ...varUint(0),
    ...varUint(0),
  ]);
}

test("decoder fails closed on an unknown opcode", () => {
  const result = decodeBytes(moduleWithSingleWord(0xff));
  assert.equal(result.ok, false);
  assert.equal(result.module, null);
  assert.match(result.diagnostics.map((d) => d.message).join("\n"), /unknown opcode 255/);
});

test("decoder fails closed when an instruction is missing its AUX word", () => {
  const result = decodeBytes(moduleWithSingleWord(7));
  assert.equal(result.ok, false);
  assert.equal(result.module, null);
  assert.match(result.diagnostics.map((d) => d.message).join("\n"), /AUX word/);
});

function minimalProto(childProtoIds = []) {
  return [
    1, 0, 0, 0,
    0,
    ...varUint(0),
    ...varUint(0),
    ...varUint(0),
    ...varUint(childProtoIds.length),
    ...childProtoIds.flatMap((id) => varUint(id)),
    ...varUint(0),
    ...varUint(0),
    0,
    ...varUint(0),
    ...varUint(0),
  ];
}

function moduleWithChildProtoIds(childProtoIds) {
  return Uint8Array.from([
    4, 1,
    ...varUint(0),
    ...varUint(1),
    ...minimalProto(childProtoIds),
    ...varUint(0),
  ]);
}

test("decoder rejects child proto ids outside the module proto table", () => {
  const result = decodeBytes(moduleWithChildProtoIds([1]));
  assert.equal(result.ok, false);
  assert.equal(result.module, null);
  assert.match(result.diagnostics.map((d) => d.message).join("\n"), /child proto id 1.*out of range/i);
});

function moduleWithProtoGraph(childLists, mainProtoId = 0) {
  return Uint8Array.from([
    4, 1,
    ...varUint(0),
    ...varUint(childLists.length),
    ...childLists.flatMap((children) => minimalProto(children)),
    ...varUint(mainProtoId),
  ]);
}

test("decoder rejects cycles in the proto graph", () => {
  const result = decodeBytes(moduleWithProtoGraph([[0]]));
  assert.equal(result.ok, false);
  assert.equal(result.module, null);
  assert.match(result.diagnostics.map((d) => d.message).join("\n"), /proto graph cycle/i);
});

test("decoder enforces maxProtoDepth across child proto chains", () => {
  const limits = {
    maxInputBytes: 1024 * 1024,
    maxProtos: 16,
    maxInstructionsPerProto: 16,
    maxConstantsPerProto: 16,
    maxStringTableEntries: 16,
    maxProtoDepth: 2,
    maxAnalysisIterations: 100,
  };
  const result = decodeBytes(moduleWithProtoGraph([[1], [2], []]), limits);
  assert.equal(result.ok, false);
  assert.equal(result.module, null);
  assert.match(result.diagnostics.map((d) => d.message).join("\n"), /proto depth 3.*limit 2/i);
});

test("decoder accepts a proto chain exactly at maxProtoDepth", () => {
  const limits = {
    maxInputBytes: 1024 * 1024,
    maxProtos: 16,
    maxInstructionsPerProto: 16,
    maxConstantsPerProto: 16,
    maxStringTableEntries: 16,
    maxProtoDepth: 2,
    maxAnalysisIterations: 100,
  };
  const result = decodeBytes(moduleWithProtoGraph([[1], []]), limits);
  assert.equal(result.ok, true);
  assert.notEqual(result.module, null);
});
