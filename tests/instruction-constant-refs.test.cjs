const assert = require('node:assert/strict');
const test = require('node:test');
const { decodeBytes } = require('../.test-build/src/luau/decoder.js');

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

function adWord(op, d, a = 0) {
  return (op | (a << 8) | ((d & 0xffff) << 16)) >>> 0;
}

function moduleWithInstruction(words) {
  return Uint8Array.from([
    4, 1,
    ...varUint(0),
    ...varUint(1),
    1, 0, 0, 0,
    0,
    ...varUint(0),
    ...varUint(words.length),
    ...words.flatMap(u32le),
    ...varUint(1),
    0,
    ...varUint(0),
    ...varUint(0),
    ...varUint(0),
    0,
    ...varUint(0),
    ...varUint(0),
    ...varUint(0),
  ]);
}

for (const [name, words] of [
  ['LOADK', [adWord(5, 1)]],
  ['DUPTABLE', [adWord(54, 1)]],
  ['LOADKX', [66, 1]],
  ['GETGLOBAL', [7, 1]],
  ['SETGLOBAL', [8, 1]],
  ['GETTABLEKS', [15, 1]],
  ['SETTABLEKS', [16, 1]],
  ['NAMECALL', [20, 1]],
  ['FASTCALL2K', [75, 1]],
]) {
  test(`decoder rejects ${name} constant index outside the proto constant table`, () => {
    const result = decodeBytes(moduleWithInstruction(words));
    assert.equal(result.ok, false);
    assert.equal(result.module, null);
    assert.match(result.diagnostics.map((d) => d.message).join('\n'), new RegExp(`${name}.*constant.*1.*out of range`, 'i'));
  });
}

test('decoder rejects GETIMPORT D constant index outside the proto constant table', () => {
  const result = decodeBytes(moduleWithInstruction([adWord(12, 1), 0x40000000]));
  assert.equal(result.ok, false);
  assert.equal(result.module, null);
  assert.match(result.diagnostics.map((d) => d.message).join('\n'), /GETIMPORT.*constant.*1.*out of range/i);
});

test('decoder rejects GETIMPORT AUX path length zero', () => {
  const result = decodeBytes(moduleWithInstruction([adWord(12, 0), 0]));
  assert.equal(result.ok, false);
  assert.equal(result.module, null);
  assert.match(result.diagnostics.map((d) => d.message).join('\n'), /GETIMPORT.*path length 0/i);
});

test('decoder rejects GETIMPORT AUX component outside the proto constant table', () => {
  const result = decodeBytes(moduleWithInstruction([adWord(12, 0), 0x40100000]));
  assert.equal(result.ok, false);
  assert.equal(result.module, null);
  assert.match(result.diagnostics.map((d) => d.message).join('\n'), /GETIMPORT.*component 0.*constant 1.*out of range/i);
});
