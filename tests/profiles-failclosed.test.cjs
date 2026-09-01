const assert = require("node:assert/strict");
const test = require("node:test");
const { getProfile, isDecodable } = require("../.test-build/src/luau/profiles.js");

test("experimental bytecode layouts fail closed", () => {
  assert.equal(isDecodable("EXPERIMENTAL"), false);
});

test("implemented partial bytecode layouts remain decodable", () => {
  assert.equal(isDecodable("PARTIAL"), true);
});

test("current upstream bytecode v14 is recognized but fails closed until its layout is implemented", () => {
  const profile = getProfile(14);
  assert.notEqual(profile, null);
  assert.equal(profile.status, "UNSUPPORTED");
  assert.equal(isDecodable(profile.status), false);
});
