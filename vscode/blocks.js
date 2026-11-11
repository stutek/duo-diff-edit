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
  // a block of as many lines on both sides is line against line (a paragraph per line, each changed on its own):
  // it moves line by line, where Visual Studio Code draws and reverts it as one
  return out.flatMap((k) => {
    const n = k.a[1] - k.a[0];
    if (n < 2 || n !== k.b[1] - k.b[0]) return [k];
    return Array.from({ length: n }, (_, i) => ({ a: [k.a[0] + i, k.a[0] + i + 1], b: [k.b[0] + i, k.b[0] + i + 1] }));
  });
}

// The blocks the selection on one side ('a' or 'b') touches; first and last are 0-based lines of the selection.
// A cursor (first === last) inside a block picks that block alone, so of two blocks one right below the other, the
// cursor's line wins; on no block's line, it picks the block it is right below, or where one side's lines were removed.
function touched(list, side, first, last) {
  const near = list.filter((k) => Math.max(k[side][0], first) <= Math.min(k[side][1], last));
  if (first !== last) return near;
  const inside = near.filter((k) => k[side][0] <= first && first < k[side][1]);
  return inside.length ? inside : near;
}

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

// Changes inside the blocks, word by word, so one changed word in a long line moves on its own: [{ k, a: [from,
// to], b: [from, to] }] with positions [line, character]. A block one side of which has no lines is one change
// (whole: true), copied by replacement(). Tokens are words, runs of spaces, line breaks and single other characters;
// changes with only spaces between them are one change, so a changed phrase moves at once.
const TOKEN = /[\p{L}\p{N}_]+|[^\S\n]+|\n|[^\p{L}\p{N}_\s]/gu;
const space = (t) => /^[^\S\n]+$/.test(t);
function tokenDiff(x, y) {   // [[x0, x1, y0, y1]] token index runs that differ; null when too large
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const n = x.length - pre - suf, m = y.length - pre - suf;
  if (n * m > MAX_CELLS) return null;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) L[i][j] = x[pre + i] === y[pre + j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const runs = [];
  let i = 0, j = 0, si = -1, sj = -1;
  const close = () => { if (si >= 0) runs.push([pre + si, pre + i, pre + sj, pre + j]); si = -1; };
  while (i < n || j < m) {
    if (i < n && j < m && x[pre + i] === y[pre + j]) { close(); i++; j++; continue; }
    if (si < 0) { si = i; sj = j; }
    if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) i++; else j++;
  }
  close();
  const merged = [];   // runs with only spaces between them (on both sides the same tokens) become one
  for (const r of runs) {
    const p = merged[merged.length - 1];
    if (p && x.slice(p[1], r[0]).every(space)) { p[1] = r[1]; p[3] = r[3]; } else merged.push([...r]);
  }
  return merged;
}
function words(a, b, list, ignoreTrimWhitespace = true) {
  const out = [];
  for (const k of list) {
    const [a0, a1] = k.a, [b0, b1] = k.b;
    const whole = () => out.push({ k, whole: true, a: span(a, a0, a1), b: span(b, b0, b1) });
    if (a0 === a1 || b0 === b1) { whole(); continue; }
    const x = a.slice(a0, a1).join('\n').match(TOKEN) || [], y = b.slice(b0, b1).join('\n').match(TOKEN) || [];
    const runs = tokenDiff(x, y);
    if (!runs) { whole(); continue; }
    const at = (tokens, line0) => {   // token index → [line, character]
      const pos = [[line0, 0]];
      for (const t of tokens) { const [l, c] = pos[pos.length - 1]; pos.push(t === '\n' ? [l + 1, 0] : [l, c + t.length]); }
      return pos;
    };
    const pa = at(x, a0), pb = at(y, b0);
    for (const [x0, x1, y0, y1] of runs) {
      if (ignoreTrimWhitespace && x.slice(x0, x1).every(space) && y.slice(y0, y1).every(space)) continue;
      out.push({ k, a: [pa[x0], pa[x1]], b: [pb[y0], pb[y1]] });
    }
  }
  return out;
}
// the range of lines [l0, l1) on a side; where it has none, the point at which they would be
function span(lines, l0, l1) {
  if (l0 < l1) return [[l0, 0], [l1 - 1, lines[l1 - 1].length]];
  const p = l0 < lines.length ? [l0, 0] : [lines.length - 1, lines[lines.length - 1].length];
  return [p, p];
}
const before = (p, q) => p[0] < q[0] || (p[0] === q[0] && p[1] <= q[1]);   // p ≤ q
// the changes the selection [start, end] on one side touches (a cursor at either end of a change touches it)
const touchedWords = (list, side, start, end) => list.filter((w) => (w.whole
  ? touched([w.k], side, start[0], end[0]).length
  : before(w[side][0], end) && before(start, w[side][1])));
// The edit that makes change w of the target side equal to the source side, as replacement() gives it.
function wordReplacement(target, source, w, targetSide, eol = '\n') {
  if (w.whole) return replacement(target, source, w.k, targetSide, eol);
  const [[l0, c0], [l1, c1]] = w[targetSide === 'a' ? 'b' : 'a'];
  const text = l0 === l1 ? source[l0].slice(c0, c1)
    : [source[l0].slice(c0), ...source.slice(l0 + 1, l1), source[l1].slice(0, c1)].join(eol);
  return { from: w[targetSide][0], to: w[targetSide][1], text };
}

// A text after applying the edits (as the editor would), for tests and for checking the result. Texts inserted at
// the same place keep the order of the edits, as in a WorkspaceEdit: the later one is applied first.
function apply(text, edits, eol = '\n') {
  const lines = text.split(eol);
  const offset = ([line, ch]) => lines.slice(0, line).reduce((n, l) => n + l.length + eol.length, 0) + ch;
  return edits.map((e, i) => [e, i]).sort(([x, i], [y, j]) => offset(y.from) - offset(x.from) || j - i).map(([e]) => e)
    .reduce((t, e) => t.slice(0, offset(e.from)) + e.text + t.slice(offset(e.to)), text);
}

module.exports = { MAX_CELLS, blocks, touched, replacement, words, touchedWords, wordReplacement, apply };
