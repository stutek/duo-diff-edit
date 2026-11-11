// Changed blocks between two texts, for copying a block from one side of a diff to the other (as Meld's push left
// and push right). Without the vscode module, so plain `node --test` covers it.
//
// Visual Studio Code does not give extensions its diff, so this is a longest-common-subsequence line diff that
// honours the diff editor's diffEditor.ignoreTrimWhitespace, and picks blocks by the rule of the built-in
// Revert Block: every block whose line range [start, end) the selection's lines [first, last) touch, so a cursor
// on the line right below a block, or where one side's lines were removed, also picks it.
'use strict';

const MAX_CELLS = 4e6;   // lines × lines of the differing middle; beyond it the table would take too much memory

// [{ a: [start, end), b: [start, end) }]: 0-based line ranges of each changed block, in order; null when too large.
function blocks(a, b, ignoreTrimWhitespace = true) {
  const key = ignoreTrimWhitespace ? (s) => s.trim() : (s) => s;
  const A = a.map(key), B = b.map(key);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const n = A.length - pre - suf, m = B.length - pre - suf;
  if (n * m > MAX_CELLS) return null;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));   // L[i][j]: common lines of A[i..], B[j..]
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = A[pre + i] === B[pre + j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0, si = -1, sj = -1;
  const close = () => { if (si >= 0) out.push({ a: [pre + si, pre + i], b: [pre + sj, pre + j] }); si = -1; };
  while (i < n || j < m) {
    if (i < n && j < m && A[pre + i] === B[pre + j]) { close(); i++; j++; continue; }
    if (si < 0) { si = i; sj = j; }
    if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) i++; else j++;   // removed lines first, then added
  }
  close();
  return out;
}

// The blocks the selection on one side ('a' or 'b') touches; first and last are 0-based lines of the selection.
const touched = (list, side, first, last) =>
  list.filter((k) => Math.max(k[side][0], first) <= Math.min(k[side][1], last));

// The edit that makes block k of the target side equal to the source side: { from: [line, character], to: [line,
// character], text }. Lines are a text split at its line breaks, so the last line has none (it is '' when the text
// ends with one); a block reaches the end of one side exactly when it reaches the end of the other.
function replacement(target, source, k, targetSide, eol = '\n') {
  const sourceSide = targetSide === 'a' ? 'b' : 'a';
  const [t0, t1] = k[targetSide], [s0, s1] = k[sourceSide];
  const lines = source.slice(s0, s1);
  if (t1 < target.length) return { from: [t0, 0], to: [t1, 0], text: lines.map((l) => l + eol).join('') };
  const end = [target.length - 1, target[target.length - 1].length];
  if (t0 === target.length) return { from: end, to: end, text: eol + lines.join(eol) };   // lines added after the last
  if (!lines.length && t0 > 0) return { from: [t0 - 1, target[t0 - 1].length], to: end, text: '' };   // with the break before
  return { from: [t0, 0], to: end, text: lines.join(eol) };
}

// A text after applying the edits (as the editor would), for tests and for checking the result.
function apply(text, edits, eol = '\n') {
  const lines = text.split(eol);
  const offset = ([line, ch]) => lines.slice(0, line).reduce((n, l) => n + l.length + eol.length, 0) + ch;
  return [...edits].sort((x, y) => offset(y.from) - offset(x.from))
    .reduce((t, e) => t.slice(0, offset(e.from)) + e.text + t.slice(offset(e.to)), text);
}

module.exports = { MAX_CELLS, blocks, touched, replacement, apply };
