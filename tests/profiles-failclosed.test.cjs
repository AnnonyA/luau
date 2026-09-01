const assert = require("node:assert/strict");
const test = require("node:test");
const { isDecodable } = require("../.test-build/src/luau/profiles.js");

test("experimental bytecode layouts fail closed", () => {
  assert.equal(isDecodable("EXPERIMENTAL"), false);
});

test("implemented partial bytecode layouts remain decodable", () => {
  assert.equal(isDecodable("PARTIAL"), true);
});
