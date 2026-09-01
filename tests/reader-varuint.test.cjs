const assert = require("node:assert/strict");
const test = require("node:test");
const { Reader } = require("../.test-build/src/luau/reader.js");

test("varUint accepts the largest uint32 value", () => {
  const reader = new Reader(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x0f]));
  assert.equal(reader.varUint("max"), 0xffffffff);
});

test("varUint rejects a five-byte payload above uint32", () => {
  const reader = new Reader(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x10]));
  assert.throws(() => reader.varUint("overflow"), /32-bit overflow/);
});

test("varUint rejects continuation after the fifth byte", () => {
  const reader = new Reader(Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x00]));
  assert.throws(() => reader.varUint("continuation"), /32-bit overflow/);
});
