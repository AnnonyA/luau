const assert = require('node:assert/strict');
const test = require('node:test');
const { buildCFG } = require('../.test-build/src/luau/cfg.js');

function ins(pc, opname, D = 0) {
  return {
    pc,
    op: 0,
    opname,
    mode: 'AD',
    A: 0,
    B: 0,
    C: 0,
    D,
    E: 0,
    size: 1,
  };
}

test('natural loop body excludes unreachable predecessor of a reachable latch', () => {
  const proto = {
    instructions: [
      ins(0, 'JUMP', 1),
      ins(1, 'JUMP', 1),
      ins(2, 'JUMPIF', 1),
      ins(3, 'JUMPBACK', -2),
      ins(4, 'RETURN'),
    ],
  };

  const cfg = buildCFG(proto);
  assert.deepEqual([...cfg.reachable].sort((a, b) => a - b), [0, 2, 3, 4]);
  assert.equal(cfg.loops.length, 1);
  assert.deepEqual([...cfg.loops[0].body].sort((a, b) => a - b), [2, 3]);
});
