// Unit tests of vscode/blocks.js: node --test test/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { blocks, touched, replacement, apply, MAX_CELLS } = require('../vscode/blocks');

const split = (t, eol = '\n') => t.split(eol);
// Copy blocks from one side to the other, as the extension does: every edit computed on the texts before any applies.
const copy = (from, to, list, targetSide, eol = '\n') =>
  apply(to, list.map((k) => replacement(split(to, eol), split(from, eol), k, targetSide, eol)), eol);

test('blocks: equal texts have none; a changed, an added and a removed line each make one', () => {
  assert.deepEqual(blocks(['a', 'b'], ['a', 'b']), []);
  assert.deepEqual(blocks(['a', 'b', 'c'], ['a', 'B', 'c']), [{ a: [1, 2], b: [1, 2] }]);
  assert.deepEqual(blocks(['a', 'c'], ['a', 'b', 'c']), [{ a: [1, 1], b: [1, 2] }]);
  assert.deepEqual(blocks(['a', 'b', 'c'], ['a', 'c']), [{ a: [1, 2], b: [1, 1] }]);
  assert.deepEqual(blocks(['x', 'a', 'y'], ['X', 'a', 'Y']), [{ a: [0, 1], b: [0, 1] }, { a: [2, 3], b: [2, 3] }]);
});

test('blocks: leading and trailing whitespace counts only when diffEditor.ignoreTrimWhitespace is off', () => {
  assert.deepEqual(blocks(['a', '  b'], ['a', 'b']), []);
  assert.deepEqual(blocks(['a', '  b'], ['a', 'b'], false), [{ a: [1, 2], b: [1, 2] }]);
});

test('blocks: a middle too large for the table gives null, not a wrong answer', () => {
  const n = Math.ceil(Math.sqrt(MAX_CELLS)) + 1;
  assert.equal(blocks(Array.from({ length: n }, (_, i) => `a${i}`), Array.from({ length: n }, (_, i) => `b${i}`)), null);
});

test('touched: the rule of Revert Block, a block [s, e) is picked by a cursor on lines s to e', () => {
  const list = [{ a: [2, 4], b: [2, 3] }, { a: [6, 6], b: [5, 7] }];
  assert.deepEqual(touched(list, 'a', 1, 1), []);
  assert.deepEqual(touched(list, 'a', 2, 2), [list[0]]);
  assert.deepEqual(touched(list, 'a', 4, 4), [list[0]]);   // the line right below the block
  assert.deepEqual(touched(list, 'a', 6, 6), [list[1]]);   // where the lines of side a were removed
  assert.deepEqual(touched(list, 'b', 3, 5), list);        // a selection over both
});

test('replacement: copying every block makes the target equal to the source, either way, with or without a final line break', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const words = ['one', 'two', 'three', '', '  two', 'four'];
  const text = () => {
    const lines = Array.from({ length: rnd(7) }, () => words[rnd(words.length)]);
    return lines.join('\n') + (rnd(2) ? '\n' : '');
  };
  for (let i = 0; i < 3000; i++) {
    const a = text(), b = text();
    for (const eol of ['\n', '\r\n']) {
      const A = a.replace(/\n/g, eol), B = b.replace(/\n/g, eol);
      const list = blocks(split(A, eol), split(B, eol), false);
      assert.equal(copy(B, A, list, 'a', eol), B, `b → a: ${JSON.stringify([A, B])}`);
      assert.equal(copy(A, B, list, 'b', eol), A, `a → b: ${JSON.stringify([A, B])}`);
    }
  }
});

test('replacement: copying one block leaves the other blocks as they were', () => {
  const a = 'x\nold one\nsame\nold two\n', b = 'x\nnew one\nsame\nnew two\n';
  const list = blocks(split(a), split(b));
  assert.equal(copy(b, a, [list[0]], 'a'), 'x\nnew one\nsame\nold two\n');
  assert.equal(copy(a, b, [list[1]], 'b'), 'x\nnew one\nsame\nold two\n');
});
