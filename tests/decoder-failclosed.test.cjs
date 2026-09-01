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

function encodeAsciiString(value) {
  const bytes = Array.from(Buffer.from(value, "utf8"));
  return [...varUint(bytes.length), ...bytes];
}

function protoWithConstants(constants) {
  return [
    1, 0, 0, 0,
    0,
    ...varUint(0),
    ...varUint(0),
    ...varUint(constants.length),
    ...constants.flat(),
    ...varUint(0),
    ...varUint(0),
    ...varUint(0),
    0,
    ...varUint(0),
    ...varUint(0),
  ];
}

function moduleWithConstants(constants, strings = []) {
  return Uint8Array.from([
    4, 1,
    ...varUint(strings.length),
    ...strings.flatMap(encodeAsciiString),
    ...varUint(1),
    ...protoWithConstants(constants),
    ...varUint(0),
  ]);
}

function constantString(stringId) {
  return [3, ...varUint(stringId)];
}

function constantClosure(protoId) {
  return [6, ...varUint(protoId)];
}

function constantTable(keys) {
  return [5, ...varUint(keys.length), ...keys.flatMap(varUint)];
}

function constantImport(count, ids) {
  const [id0 = 0, id1 = 0, id2 = 0] = ids;
  const packed = (((count & 3) << 30) | ((id0 & 0x3ff) << 20) | ((id1 & 0x3ff) << 10) | (id2 & 0x3ff)) >>> 0;
  return [4, ...u32le(packed)];
}

test("decoder rejects string constants with the reserved zero string id", () => {
  const result = decodeBytes(moduleWithConstants([constantString(0)], ["ok"]));
  assert.equal(result.ok, false);
  assert.equal(result.module, null);
  assert.match(result.diagnostics.map((d) => d.message).join("\n"), /string constant.*id 0/i);
});

test("decoder rejects string constants outside the string table", () => {
  const result = decodeBytes(moduleWithConstants([constantString(2)], ["only"]));
  assert.equal(result.ok, false);
  assert.equal(result.module, null);
  assert.match(result.diagnostics.map((d) => d.message).join("\n"), /string constant.*id 2.*out of range/i);
});

test("decoder rejects closure constants outside the module proto table", () => {
  const result = decodeBytes(moduleWithConstants([constantClosure(1)]));
  assert.equal(result.ok, false);
  assert.equal(result.module, null);
  assert.match(result.diagnostics.map((d) => d.message).join("\n"), /closure constant.*proto id 1.*out of range/i);
});

test("decoder rejects table constants with out-of-range constant keys", () => {
  const result = decodeBytes(moduleWithConstants([constantTable([1])]));
  assert.equal(result.ok, false);
  assert.equal(result.module, null);
  assert.match(result.diagnostics.map((d) => d.message).join("\n"), /table constant.*key 1.*out of range/i);
});

test("decoder rejects import constants with out-of-range constant ids", () => {
  const result = decodeBytes(moduleWithConstants([constantImport(1, [1])]));
  assert.equal(result.ok, false);
  assert.equal(result.module, null);
  assert.match(result.diagnostics.map((d) => d.message).join("\n"), /import constant.*id 1.*out of range/i);
});

test("decoder rejects import constants with a zero-length path", () => {
  const result = decodeBytes(moduleWithConstants([constantImport(0, [0])]));
  assert.equal(result.ok, false);
  assert.equal(result.module, null);
  assert.match(result.diagnostics.map((d) => d.message).join("\n"), /import constant.*path length 0/i);
});
