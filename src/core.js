// snapshot, check and restore.
//
// A snapshot keeps, per file, the protected settings and a full copy of the
// file. check compares the file now with the snapshot. restore backs up the
// file, then puts settings back: by default only the ones that were removed
// or emptied (what an update that wipes settings does); with `changed`, also
// the ones whose value differs.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse, applyPatches, Unsupported } from './formats.js';
import { equal, get, has, isEmpty, isObj, pathLabel } from './values.js';
import { parseSpec, storeDir, targets } from './targets.js';

const SNAP_VERSION = 1;

// ---------- store ----------

function snapPath(env) {
  return path.join(storeDir(env), 'snapshot.json');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function writeAtomic(file, text, mode) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.agentkeep-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function loadSnapshot(env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(snapPath(env), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const snap = JSON.parse(raw);
  if (snap.version !== SNAP_VERSION) throw new Error(`snapshot version ${snap.version} is not supported`);
  return snap;
}

function saveSnapshot(snap, env) {
  writeAtomic(snapPath(env), JSON.stringify(snap, null, 2) + '\n', 0o600);
}

function backup(target, raw, env) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${target.id.replace('/', '-')}-${stamp}${path.extname(target.file)}`;
  const file = path.join(storeDir(env), 'backups', name);
  writeAtomic(file, raw, 0o600);
  return file;
}

// ---------- reading ----------

// Read a target's file: { state, raw, data, error }.
// state: ok | missing | empty | unreadable | unsupported
export function readTarget(target) {
  let raw;
  try {
    raw = fs.readFileSync(target.file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', error: err.message };
  }
  if (raw.replace(/^﻿/, '').trim() === '') return { state: 'empty', raw };
  try {
    return { state: 'ok', raw, data: parse(target.format, raw) };
  } catch (err) {
    return { state: err instanceof Unsupported ? 'unsupported' : 'unreadable', raw, error: err.message };
  }
}

// The protected settings in parsed data: [{ path, value }].
export function collect(target, data) {
  const items = [];
  for (const spec of target.watch) {
    const { path: p, each } = parseSpec(spec);
    if (!has(data, p)) continue;
    const v = get(data, p);
    if (each && isObj(v)) for (const k of Object.keys(v)) items.push({ path: [...p, k], value: v[k] });
    else items.push({ path: p, value: v });
  }
  // JSON round trip turns TOML dates into strings, as they are stored.
  return JSON.parse(JSON.stringify(items));
}

function sha(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

// ---------- check ----------

// Compare one target with its snapshot entry.
// Returns { id, tool, file, state, error, missing[], emptied[], changed[], added[] }.
export function checkTarget(target, entry) {
  const r = readTarget(target);
  const out = { id: target.id, tool: target.tool, file: target.file, state: r.state, error: r.error,
    missing: [], emptied: [], changed: [], added: [] };
  if (!entry) {
    out.state = r.state === 'ok' ? 'no-snapshot' : r.state;
    return out;
  }
  if (r.state !== 'ok') {
    if (r.state === 'missing' || r.state === 'empty') out.missing = entry.items.map((i) => ({ path: i.path, was: i.value }));
    return out;
  }
  const now = collect(target, r.data);
  const nowByKey = new Map(now.map((i) => [JSON.stringify(i.path), i]));
  for (const old of entry.items) {
    const k = JSON.stringify(old.path);
    const cur = nowByKey.get(k);
    nowByKey.delete(k);
    if (!cur) out.missing.push({ path: old.path, was: old.value });
    else if (isEmpty(cur.value) && !isEmpty(old.value)) out.emptied.push({ path: old.path, was: old.value, now: cur.value });
    else if (!equal(cur.value, old.value)) out.changed.push({ path: old.path, was: old.value, now: cur.value });
  }
  for (const cur of nowByKey.values()) out.added.push({ path: cur.path, now: cur.value });
  return out;
}

export function select(env, tools) {
  const all = targets(env);
  return tools?.length ? all.filter((t) => tools.includes(t.tool)) : all;
}

export function check({ env = process.env, tools } = {}) {
  const snap = loadSnapshot(env);
  return {
    snapshotAt: snap?.takenAt ?? null,
    results: select(env, tools).map((t) => checkTarget(t, snap?.targets[t.id])),
  };
}

export function isDamaged(r) {
  return r.missing.length > 0 || r.emptied.length > 0;
}

// ---------- snapshot ----------

// Take a snapshot of the targets that read cleanly. Refuses (unless force)
// to replace a snapshot entry with one that has lost protected settings,
// so a broken state is never saved over a good one.
export function snapshot({ env = process.env, tools, force = false } = {}) {
  const old = loadSnapshot(env);
  const snap = old ?? { version: SNAP_VERSION, targets: {} };
  const report = [];
  for (const t of select(env, tools)) {
    const r = readTarget(t);
    if (r.state !== 'ok') {
      report.push({ id: t.id, file: t.file, state: r.state, error: r.error, saved: false });
      continue;
    }
    const prev = old?.targets[t.id];
    if (prev && !force) {
      const c = checkTarget(t, prev);
      if (isDamaged(c)) {
        report.push({ id: t.id, file: t.file, state: 'damaged', saved: false, lost: [...c.missing, ...c.emptied] });
        continue;
      }
    }
    const items = collect(t, r.data);
    const copy = path.join(storeDir(env), 'files', t.id.replace('/', '-') + path.extname(t.file));
    writeAtomic(copy, r.raw, 0o600);
    snap.targets[t.id] = { file: t.file, format: t.format, sha: sha(r.raw), copy, items };
    report.push({ id: t.id, file: t.file, state: 'ok', saved: true, count: items.length });
  }
  snap.takenAt = new Date().toISOString();
  if (report.some((x) => x.saved)) saveSnapshot(snap, env);
  return report;
}

// ---------- restore ----------

// Put settings back. Returns one report per target:
// { id, file, action, restored[], backup, rewrote, error }
// action: none | patched | replaced | skipped | planned
export function restore({ env = process.env, tools, changed = false, dryRun = false } = {}) {
  const snap = loadSnapshot(env);
  if (!snap) throw new Error('no snapshot yet; run `agentkeep snapshot` first');
  const reports = [];
  for (const t of select(env, tools)) {
    const entry = snap.targets[t.id];
    if (!entry) continue;
    reports.push(restoreTarget(t, entry, { env, changed, dryRun }));
  }
  return reports;
}

function restoreTarget(t, entry, { env, changed, dryRun }) {
  const r = readTarget(t);
  const base = { id: t.id, file: t.file, restored: [] };

  // The whole file is gone or blank: put the snapshot copy back.
  if (r.state === 'missing' || r.state === 'empty') {
    const copy = fs.readFileSync(entry.copy, 'utf8');
    if (dryRun) return { ...base, action: 'planned', replace: true, restored: entry.items.map((i) => i.path) };
    const bk = r.state === 'empty' ? backup(t, r.raw, env) : null;
    writeAtomic(t.file, copy);
    return { ...base, action: 'replaced', backup: bk, restored: entry.items.map((i) => i.path) };
  }
  // A file that is not valid, or that we can't edit safely, is left alone.
  if (r.state !== 'ok') return { ...base, action: 'skipped', error: `${r.state}: ${r.error}` };

  const c = checkTarget(t, entry);
  const todo = [...c.missing, ...c.emptied, ...(changed ? c.changed : [])];
  if (todo.length === 0) return { ...base, action: 'none' };

  const patches = todo.map((d) => ({ path: d.path, value: d.was }));
  let ref;
  try { ref = parse(t.format, fs.readFileSync(entry.copy, 'utf8')); } catch { ref = undefined; }
  const { text, rewrote } = applyPatches(t.format, r.raw, patches, ref);
  if (dryRun) return { ...base, action: 'planned', rewrote, restored: todo.map((d) => d.path) };

  const bk = backup(t, r.raw, env);
  writeAtomic(t.file, text);
  // Read back and make sure every restored setting is now as in the snapshot.
  const after = checkTarget(t, entry);
  const still = [...after.missing, ...after.emptied, ...(changed ? after.changed : [])];
  if (still.length) {
    writeAtomic(t.file, r.raw);
    return { ...base, action: 'skipped', backup: bk,
      error: `write did not take (${still.map((d) => pathLabel(d.path)).join(', ')}); file put back as it was` };
  }
  return { ...base, action: 'patched', backup: bk, rewrote, restored: todo.map((d) => d.path) };
}
