// Reading and writing settings files without wrecking their formatting.
//
// JSON files are written back with the indentation and line endings they
// had. TOML files get missing settings put back as text, so comments and
// layout survive; only when that can't be done cleanly is the whole file
// rewritten, and the caller is told so.

import * as TOML from 'smol-toml';
import { equal, get, has, isObj, nest, set } from './values.js';

export class Unsupported extends Error {}

export function parse(format, raw) {
  const text = raw.replace(/^﻿/, '');
  if (text.trim() === '') throw new Error('the file is empty');
  if (format === 'toml') return TOML.parse(text);
  try {
    return JSON.parse(text);
  } catch (err) {
    // A file that only fails because of comments is the user's JSONC, not a
    // broken file. Never overwrite it.
    try {
      JSON.parse(stripJsonComments(text));
    } catch {
      throw err;
    }
    throw new Unsupported('the file has comments (JSONC); agentkeep only edits plain JSON');
  }
}

// Remove // and /* */ comments outside strings.
export function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

// The line ending most lines use; files edited by several tools often mix them.
export function eolOf(raw) {
  const crlf = (raw.match(/\r\n/g) || []).length;
  const lf = (raw.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

// Apply patches ([{path, value}]) to the file text. Returns
// { text, rewrote } where rewrote is true if formatting could not be kept.
// `ref` is the file as it was at snapshot time; a key that comes back is put
// where it sat there, after the same neighbour, instead of at the end.
export function applyPatches(format, raw, patches, ref) {
  const current = parse(format, raw);
  const want = parse(format, raw);
  for (const p of patches) set(want, p.path, p.value);
  if (format === 'json') {
    if (ref) for (const p of patches) if (!has(current, p.path)) reposition(want, ref, p.path);
    return { text: writeJson(raw, want), rewrote: false };
  }
  return patchToml(raw, current, want, patches);
}

// Move the last key of `path` in `obj` to follow its neighbour in `ref`.
// Parents are repositioned as well, in case they were recreated.
function reposition(obj, ref, path) {
  for (let depth = 1; depth <= path.length; depth++) {
    const parentPath = path.slice(0, depth - 1);
    const key = path[depth - 1];
    const parent = parentPath.length ? get(obj, parentPath) : obj;
    const refParent = parentPath.length ? get(ref, parentPath) : ref;
    if (!isObj(parent) || !isObj(refParent) || !Object.hasOwn(refParent, key)) continue;
    const refKeys = Object.keys(refParent);
    const prev = refKeys.slice(0, refKeys.indexOf(key)).reverse().find((k) => k !== key && Object.hasOwn(parent, k));
    const keys = Object.keys(parent).filter((k) => k !== key);
    keys.splice(prev === undefined ? 0 : keys.indexOf(prev) + 1, 0, key);
    const entries = keys.map((k) => [k, parent[k]]);
    for (const k of Object.keys(parent)) delete parent[k];
    for (const [k, v] of entries) parent[k] = v;
  }
}

function writeJson(raw, obj) {
  const indent = raw.match(/^([ \t]+)"/m)?.[1] ?? '  ';
  const eol = eolOf(raw);
  let text = JSON.stringify(obj, null, indent);
  if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  const bom = raw.startsWith('﻿') ? '﻿' : '';
  const trailing = /\r?\n$/.test(raw) ? eol : '';
  return bom + text + trailing;
}

function patchToml(raw, current, want, patches) {
  const eol = eolOf(raw);
  const fix = (s) => (eol === '\r\n' ? s.replace(/\r?\n/g, '\r\n') : s);
  // Text insertion only works for settings that are absent; anything that
  // exists and has to change needs a rewrite.
  if (patches.every((p) => !has(current, p.path))) {
    let head = '';
    let tail = '';
    for (const p of patches) {
      if (p.path.length === 1 && !isObj(p.value)) head += TOML.stringify({ [p.path[0]]: p.value });
      else tail += eol + TOML.stringify(nest(p.path, p.value));
    }
    let text = raw;
    if (head) {
      const m = /^[ \t]*\[/m.exec(text);
      const at = m ? m.index : text.length;
      // Put the keys right after the last line of top-level settings,
      // keeping whatever blank lines were there before the first table.
      const before = text.slice(0, at);
      const content = before.replace(/\s*$/, '');
      const gap = before.slice(content.length);
      const keys = fix(head).replace(/\s*$/, '');
      text = content + (content ? eol : '') + keys + (gap || eol) + text.slice(at);
    }
    if (tail) text = text.replace(/\s*$/, '') + eol + fix(tail);
    try {
      if (equal(TOML.parse(text), want)) return { text, rewrote: false };
    } catch {
      // fall through to a full rewrite
    }
  }
  return { text: fix(TOML.stringify(want)), rewrote: true };
}

export { get };
