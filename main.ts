// mend: applies an edit an AI model wrote to a tree of text files, in four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), exactly as SPEC.md specifies. Node 22, standard library alone;
// run as `node main.ts [options] [PATCH]`. In a trial the grader runs `node /bot/main.ts` with
// MAKEFUN_ENV_URL set and this file hands over to runner.ts (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}
const parseErr = (n: number): Exit2 => new Exit2(`error: parse ${n}`);

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file split into lines with its own line break (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const lines = text.split(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function joinFile(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

// ---- Section 5: matching lines at three tiers ----

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];
const tierFn = [(s: string) => s, trimTrail, trimBoth];

interface Occurrences {
  tier: number;
  positions: number[];
}

/** All occurrences of O in fileLines at the first tier that has one, at positions >= from. */
function occurrences(fileLines: string[], O: string[], strict: boolean, from = 0, eofOnly = false): Occurrences | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const f = tierFn[t]!;
    const Ot = O.map(f);
    const positions: number[] = [];
    for (let i = from; i + O.length <= fileLines.length; i++) {
      if (eofOnly && i + O.length !== fileLines.length) continue;
      let ok = true;
      for (let k = 0; k < O.length; k++) {
        if (f(fileLines[i + k]!) !== Ot[k]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** First line at or after `from` equal to the anchor at the first tier where one is (single line, both sides). */
function findAnchor(fileLines: string[], from: number, anchor: string, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const f = tierFn[t]!;
    const a = f(anchor);
    for (let i = from; i < fileLines.length; i++) {
      if (f(fileLines[i]!) === a) return i;
    }
  }
  return -1;
}

/** One line of N: its text, whether it is a context line, and for a context line its index in O. */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** The lines N writes over the match at pos: context lines keep the file's own line; tier 2 re-indents the rest. */
function buildReplacement(fileLines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const F = leadWS(fileLines[pos] ?? '');
  const P = leadWS(O[0] ?? '');
  return N.map((n) => {
    if (n.ctx) return fileLines[pos + n.oIdx]!;
    if (tier === 2 && !/^[ \t]*$/.test(n.text) && n.text.startsWith(P)) return F + n.text.slice(P.length);
    return n.text;
  });
}

/** Split a hunk/chunk body into O (context + old) and N (context + new), each in body order. */
function splitBody(body: { kind: string; text: string }[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const e of body) {
    if (e.kind === 'ctx') {
      N.push({ text: e.text, ctx: true, oIdx: O.length });
      O.push(e.text);
    } else if (e.kind === 'old') {
      O.push(e.text);
    } else if (e.kind === 'new') {
      N.push({ text: e.text, ctx: false, oIdx: -1 });
    }
  }
  return { O, N };
}

// ---- Section 4: detecting the format ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 9: JSON edits ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f.lines, f.br, f.finalBreak));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw parseErr(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw parseErr(first + 1);
    }
    if (!Array.isArray(v)) throw parseErr(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw parseErr(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw parseErr(i + 1);
    edits.push(e);
  });
  return edits;
}

// ---- Section 6: unified diffs ----

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  fromEmpty: boolean;
}
interface Hunk {
  A: number;
  body: BodyLine[];
}
interface USection {
  gitOld?: string;
  gitNew?: string;
  oldPath?: string | null;
  newPath?: string | null;
  hasPair: boolean;
  renameFrom?: string;
  renameTo?: string;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;

const isDiffGit = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ') || l.startsWith('diff --git\t');

/** The path a ---/+++ header line names: after the four characters, up to the first tab, trimmed; /dev/null is no file. */
function headerPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHunk: Hunk | null = null;
  const newSection = (): USection => {
    const s: USection = { hasPair: false, newFileMode: false, deletedFileMode: false, hunks: [] };
    sections.push(s);
    return s;
  };
  const finishHunk = (): void => {
    if (inHunk === null) return;
    while (inHunk.body.length > 0 && inHunk.body[inHunk.body.length - 1]!.fromEmpty) inHunk.body.pop();
    inHunk = null;
  };
  const pairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (inHunk !== null) {
      if (isDiffGit(line) || pairAt(i) || line.startsWith('@@')) {
        finishHunk();
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        const kind = line === '' || line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : line[0] === '+' ? 'new' : 'bs';
        inHunk.body.push({ kind, text: line === '' ? '' : line.slice(1), fromEmpty: line === '' });
        i += 1;
        continue;
      }
      finishHunk();
      continue;
    }
    if (isDiffGit(line)) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw parseErr(i + 1);
      cur = newSection();
      cur.gitOld = m[1];
      cur.gitNew = m[2];
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw parseErr(i + 1);
      const m = HUNK_RE.exec(line);
      if (m === null) throw parseErr(i + 1);
      inHunk = { A: Number(m[1]), body: [] };
      cur.hunks.push(inHunk);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) {
        if (!pairAt(i)) throw parseErr(i + 2);
        if (cur.hasPair) cur = newSection();
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.newFileMode = true;
        i += 1;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.deletedFileMode = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (pairAt(i)) {
      cur = newSection();
      cur.oldPath = headerPath(line);
      cur.newPath = headerPath(lines[i + 1]!);
      cur.hasPair = true;
      i += 2;
      continue;
    }
    i += 1;
  }
  finishHunk();
  return sections;
}

/** Whether a `\` line follows the hunk's last context or + line. */
function bsAfterLastCtxOrNew(body: BodyLine[]): boolean {
  for (let j = body.length - 1; j >= 0; j--) {
    if (body[j]!.kind === 'ctx' || body[j]!.kind === 'new') return body[j + 1]?.kind === 'bs';
  }
  return false;
}

/** Apply a section's hunks in order to a file's lines (SPEC.md section 6, "Applying hunks"). */
function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { O, N } = splitBody(h.body);
    const bs = bsAfterLastCtxOrNew(h.body);
    if (O.length === 0) {
      let pos = h.A + d;
      if (pos < 0) pos = 0;
      if (pos > f.lines.length) pos = f.lines.length;
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...N.map((n) => n.text));
      if (atEnd) f.finalBreak = !bs;
      d += N.length;
    } else {
      const occ = occurrences(f.lines, O, strict);
      if (occ === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = occ.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of occ.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const runsToEnd = best + O.length === f.lines.length;
      const repl = buildReplacement(f.lines, best, O, N, occ.tier);
      f.lines.splice(best, O.length, ...repl);
      if (runsToEnd) f.finalBreak = !bs;
      d += N.length - O.length;
    }
  }
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  const oldP = sec.oldPath !== undefined ? sec.oldPath : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
  const newP = sec.newPath !== undefined ? sec.newPath : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
  return (tree) => {
    if (newP === null && oldP !== null && oldP !== undefined) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null && newP !== null && newP !== undefined) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let bs = false;
      for (const h of sec.hunks) {
        h.body.forEach((e, j) => {
          if (e.kind === 'new') {
            plus.push(e.text);
            bs = h.body[j + 1]?.kind === 'bs';
          }
        });
      }
      tree.now.set(newP, joinFile(plus, '\n', !bs));
      return;
    }
    if (sec.newFileMode && newP !== null && newP !== undefined) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let bs = false;
      for (const h of sec.hunks) {
        h.body.forEach((e, j) => {
          if (e.kind === 'new') {
            plus.push(e.text);
            bs = h.body[j + 1]?.kind === 'bs';
          }
        });
      }
      tree.now.set(newP, joinFile(plus, '\n', !bs));
      return;
    }
    if (sec.deletedFileMode && oldP !== null && oldP !== undefined) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const from = oldP as string;
    const to = newP as string;
    if (!safe(from)) throw new Fail('unsafe', from);
    if (to !== from && !safe(to)) throw new Fail('unsafe', to);
    const text = tree.get(from);
    if (text === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const f = splitFile(text);
    applyHunks(f, sec.hunks, strict, from);
    const result = joinFile(f.lines, f.br, f.finalBreak);
    if (to !== from) {
      tree.now.set(to, result);
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    } else {
      tree.now.set(from, result);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => unifiedEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile(newLines, '\n', true));
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = splitFile(text);
    const occ = occurrences(f.lines, oldLines, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = occ.positions[0]!;
    const N: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const repl = buildReplacement(f.lines, pos, oldLines, N, occ.tier);
    f.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(f.lines, f.br, f.finalBreak));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw parseErr(sLine + 1);
    let rp = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rp = j;
        break;
      }
    }
    if (rp < 0) throw parseErr(sLine + 1);
    let path: string | null = null;
    for (let j = sLine - 1; j >= searchFrom; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw parseErr(sLine + 1);
    edits.push(srEdit(path, lines.slice(sLine + 1, eq), lines.slice(eq + 1, rp), strict));
    prevPath = path;
    searchFrom = rp + 1;
    i = rp + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface V4AChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

const isV4AHeader = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstIdx = lines.findIndex((l) => !blank(l));
  if (firstIdx < 0) throw parseErr(1);
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw parseErr(firstIdx + 1);
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && blank(lines[lastIdx]!)) lastIdx -= 1;
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw parseErr(lines.length + 1);
  const edits: Edit[] = [];
  let i = firstIdx + 1;
  while (i < lastIdx) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw parseErr(i + 1);
    }
    const headerLine = i + 1;
    const secLines: { text: string; no: number }[] = [];
    let j = i + 1;
    while (j < lastIdx && !isV4AHeader(lines[j]!)) {
      secLines.push({ text: lines[j]!, no: j + 1 });
      j += 1;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    if (kind === 'add') {
      const content: string[] = [];
      for (const s of secLines) {
        if (s.text === '') content.push('');
        else if (s.text.startsWith('+')) content.push(s.text.slice(1));
        else throw parseErr(s.no);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile(content, '\n', true));
      });
    } else if (kind === 'delete') {
      for (const s of secLines) {
        if (!blank(s.text)) throw parseErr(s.no);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let idx = 0;
      let moveTo: string | null = null;
      if (secLines.length > 0 && secLines[0]!.text.startsWith('*** Move to: ')) {
        moveTo = secLines[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: V4AChunk[] = [];
      let curChunk: V4AChunk | null = null;
      let firstChunk = true;
      for (; idx < secLines.length; idx++) {
        const s = secLines[idx]!;
        const t = s.text;
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(curChunk);
          firstChunk = false;
          continue;
        }
        if (t.trim() === '*** End of File') {
          if (curChunk === null) {
            curChunk = { anchor: null, body: [], eof: false };
            chunks.push(curChunk);
          }
          curChunk.eof = true;
          curChunk = null;
          firstChunk = false;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (curChunk === null) {
            if (!firstChunk) throw parseErr(s.no);
            curChunk = { anchor: null, body: [], eof: false };
            chunks.push(curChunk);
            firstChunk = false;
          }
          const kind2 = t === '' || t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'old' : 'new';
          curChunk.body.push({ kind: kind2, text: t === '' ? '' : t.slice(1), fromEmpty: t === '' });
          continue;
        }
        throw parseErr(s.no);
      }
      if (chunks.length === 0 && moveTo === null) throw parseErr(headerLine);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const text = tree.get(path);
        if (text === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const f = splitFile(text);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const found = findAnchor(f.lines, cursor, ch.anchor, strict);
            if (found < 0) throw new Fail('no-match', path);
            cursor = found + 1;
          }
          const { O, N } = splitBody(ch.body);
          if (O.length === 0) {
            const pos = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
            f.lines.splice(pos, 0, ...N.map((n) => n.text));
            cursor = pos + N.length;
          } else {
            const occ = occurrences(f.lines, O, strict, cursor, ch.eof);
            if (occ === null) throw new Fail('no-match', path);
            const pos = occ.positions[0]!;
            const repl = buildReplacement(f.lines, pos, O, N, occ.tier);
            f.lines.splice(pos, O.length, ...repl);
            cursor = pos + repl.length;
          }
        }
        const result = joinFile(f.lines, f.br, f.finalBreak);
        if (moveTo !== null) {
          tree.now.set(moveTo, result);
          tree.now.set(path, null);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, result);
        }
      });
    }
    i = j;
  }
  return edits;
}

// ---- Sections 1, 2, 10: invocation, output, order and atomicity ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw parseErr(1);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: { key: string; text: string }[] = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (o && n && o.was !== null && o.now === null && n.was === null && n.now !== null && !suppressed.has(oldP) && !suppressed.has(newP)) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const [p, c] of changed) {
    if (!suppressed.has(p)) rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
