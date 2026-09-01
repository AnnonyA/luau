const assert = require('node:assert/strict');
const test = require('node:test');
const { OPCODE_BY_ID, OPCODE_BY_NAME } = require('../.test-build/src/luau/opcodes.js');

const expected = [
  [59, 'DEP_FORGPREP_INEXT', false],
  [60, 'FASTCALL3', true, 6],
  [61, 'DEP_FORGPREP_NEXT', false],
  [63, 'GETVARARGS', false],
  [71, 'SUBRK', false],
  [72, 'DIVRK', false],
  [73, 'FASTCALL1', false],
  [74, 'FASTCALL2', true],
  [75, 'FASTCALL2K', true],
  [83, 'GETUDATAKS', true, 9],
  [84, 'SETUDATAKS', true, 9],
  [85, 'NAMECALLUDATA', true, 9],
];

for (const [id, name, hasAux, sinceVersion] of expected) {
  test(`opcode ${id} is ${name}`, () => {
    const spec = OPCODE_BY_ID.get(id);
    assert.ok(spec, `missing opcode ${id}`);
    assert.equal(spec.name, name);
    assert.equal(spec.hasAux, hasAux);
    assert.equal(OPCODE_BY_NAME.get(name)?.id, id);
    if (sinceVersion !== undefined) assert.equal(spec.sinceVersion, sinceVersion);
  });
}

test('runtime-only NATIVECALL opcode 62 is not accepted as serialized bytecode', () => {
  assert.equal(OPCODE_BY_ID.has(62), false);
});
