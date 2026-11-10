import fs from 'node:fs';
import path from 'node:path';
import { check, isDamaged, restore, select, snapshot } from './core.js';
import { storeDir } from './targets.js';
import { isObj, pathLabel } from './values.js';

const color = !process.env.NO_COLOR && (process.stdout.isTTY || Boolean(process.env.FORCE_COLOR));
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = paint(31), green = paint(32), yellow = paint(33), dim = paint(2), bold = paint(1);

const HELP = `agentkeep - keep Claude Code, Codex and Gemini CLI settings from being wiped

Usage:
  agentkeep snapshot [--force]     save the protected settings as they are now
  agentkeep check                  show what changed since the snapshot
  agentkeep restore [--changed]    put removed or emptied settings back
                    [--dry-run]    (--changed: also undo changed values)
  agentkeep watch                  restore automatically when a file is damaged

Options:
  --tool <claude|codex|gemini>     only this tool (repeatable)
  --json                           machine-readable output
  -h, --help                       this help

Every restore backs the file up first, to ${dim('~/.agentkeep/backups/')}.
Exit codes: 0 fine, 1 error, 2 check found removed or emptied settings.`;

function parseArgs(argv) {
  const o = { cmd: null, tools: [], force: false, changed: false, dryRun: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--force') o.force = true;
    else if (a === '--changed') o.changed = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--tool') {
      const t = argv[++i];
      if (!['claude', 'codex', 'gemini'].includes(t)) throw new Error(`--tool must be claude, codex or gemini, not ${t ?? 'nothing'}`);
      o.tools.push(t);
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (!o.cmd) o.cmd = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return o;
}

// Values can hold API keys, so check never prints a secret-looking value
// and shortens the rest.
const SECRET = /(token|secret|password|passwd|api[_-]?key|auth|credential|cookie|bearer)/i;
export function describe(p, v) {
  if (v === undefined) return 'nothing';
  if (p.some((k) => SECRET.test(k))) return typeof v === 'string' ? `${'•'.repeat(6)} (${v.length} chars)` : '•••';
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`;
  if (isObj(v)) return `{${Object.keys(v).length} key${Object.keys(v).length === 1 ? '' : 's'}}`;
  const s = JSON.stringify(v);
  return s.length > 48 ? s.slice(0, 45) + '…"' : s;
}

function tilde(file) {
  const home = process.env.AGENTKEEP_HOME || process.env.HOME || process.env.USERPROFILE || '';
  return home && file.startsWith(home) ? '~' + file.slice(home.length).replace(/\\/g, '/') : file;
}

function printCheck({ snapshotAt, results }) {
  if (!snapshotAt) {
    console.log(yellow('No snapshot yet.') + ' Run `agentkeep snapshot` while your settings are the way you want them.');
    return;
  }
  console.log(dim(`snapshot from ${new Date(snapshotAt).toLocaleString()}`) + '\n');
  for (const r of results) {
    const head = `${bold(r.id.padEnd(16))} ${dim(tilde(r.file))}`;
    if (r.state === 'no-snapshot') { console.log(`${dim('·')} ${head}  ${dim('not in snapshot')}`); continue; }
    if (r.state === 'unreadable' || r.state === 'unsupported') { console.log(`${red('!')} ${head}  ${red(r.state)}: ${r.error}`); continue; }
    if (r.state === 'missing' && r.missing.length === 0) { console.log(`${dim('·')} ${head}  ${dim('not installed')}`); continue; }
    const damaged = isDamaged(r);
    const mark = damaged ? red('✗') : r.changed.length ? yellow('~') : green('✓');
    let status = damaged ? red(r.state === 'ok' ? 'settings lost' : `file ${r.state}`)
      : r.changed.length ? yellow('changed') : green('ok');
    console.log(`${mark} ${head}  ${status}`);
    for (const d of r.missing) console.log(`    ${red('- removed')}  ${pathLabel(d.path)}  ${dim('was ' + describe(d.path, d.was))}`);
    for (const d of r.emptied) console.log(`    ${red('- emptied')}  ${pathLabel(d.path)}  ${dim('was ' + describe(d.path, d.was))}`);
    for (const d of r.changed) console.log(`    ${yellow('~ changed')}  ${pathLabel(d.path)}  ${dim(describe(d.path, d.was) + ' → ' + describe(d.path, d.now))}`);
    for (const d of r.added) console.log(`    ${dim('+ new      ' + pathLabel(d.path))}`);
  }
  const lost = results.filter(isDamaged);
  if (lost.length) console.log(`\nRun ${bold('agentkeep restore')} to put the lost settings back.`);
}

function printRestore(reports, dryRun) {
  for (const r of reports) {
    const head = `${bold(r.id.padEnd(16))} ${dim(tilde(r.file))}`;
    if (r.action === 'none') console.log(`${green('✓')} ${head}  nothing to restore`);
    else if (r.action === 'skipped') console.log(`${red('!')} ${head}  ${red('skipped')}: ${r.error}`);
    else {
      const verb = dryRun ? 'would restore' : r.action === 'replaced' ? 'file restored from snapshot' : 'restored';
      console.log(`${green('↺')} ${head}  ${verb} ${r.restored.length} setting${r.restored.length === 1 ? '' : 's'}`);
      for (const p of r.restored) console.log(`    ${pathLabel(p)}`);
      if (r.rewrote) console.log(`    ${yellow('note:')} the file had to be rewritten; comments in it are not kept`);
      if (r.backup) console.log(`    ${dim('backup: ' + tilde(r.backup))}`);
    }
  }
}

function printSnapshot(report) {
  for (const r of report) {
    const head = `${bold(r.id.padEnd(16))} ${dim(tilde(r.file))}`;
    if (r.saved) console.log(`${green('✓')} ${head}  ${r.count} setting${r.count === 1 ? '' : 's'} saved`);
    else if (r.state === 'missing') console.log(`${dim('·')} ${head}  ${dim('not installed')}`);
    else if (r.state === 'damaged') {
      console.log(`${red('✗')} ${head}  ${red('not saved')}: ${r.lost.length} setting${r.lost.length === 1 ? ' is' : 's are'} missing since the last snapshot`);
      console.log(`    run ${bold('agentkeep restore')}, or ${bold('agentkeep snapshot --force')} if you removed them on purpose`);
    } else console.log(`${red('!')} ${head}  ${red(r.state)}${r.error ? ': ' + r.error : ''}`);
  }
  console.log(dim(`\nstored in ${tilde(storeDir())}. It holds copies of these files, including any API keys in them.`));
}

// ---------- watch ----------

function watch(opts) {
  const env = process.env;
  const ts = () => new Date().toLocaleTimeString();
  const log = (s) => console.log(`${dim(ts())} ${s}`);
  const targets = select(env, opts.tools);
  const lastRepair = new Map();
  const MIN_GAP = 30_000;
  let timer = null;

  const sweep = () => {
    let res;
    try { res = check({ env, tools: opts.tools }); } catch (err) { log(red('check failed: ' + err.message)); return; }
    if (!res.snapshotAt) { log(yellow('no snapshot yet; run `agentkeep snapshot` first')); return; }
    const damaged = res.results.filter(isDamaged);
    for (const r of damaged) {
      const lost = [...r.missing, ...r.emptied].map((d) => pathLabel(d.path)).join(', ');
      if (Date.now() - (lastRepair.get(r.id) ?? 0) < MIN_GAP) {
        log(yellow(`${r.id}: lost ${lost} again within 30s; not fighting it, check what is rewriting the file`));
        continue;
      }
      lastRepair.set(r.id, Date.now());
      const tool = r.id.split('/')[0];
      const [rep] = restore({ env, tools: [tool] }).filter((x) => x.id === r.id);
      if (rep?.action === 'patched' || rep?.action === 'replaced') log(green(`${r.id}: restored ${lost}`) + dim(`  (backup ${tilde(rep.backup ?? '-')})`));
      else log(red(`${r.id}: could not restore: ${rep?.error ?? 'unknown'}`));
    }
    // Healthy files are re-snapshotted, so settings you add are protected too.
    const healthy = res.results.filter((r) => r.state === 'ok' && !isDamaged(r) && (r.changed.length || r.added.length));
    if (healthy.length) {
      const tools = [...new Set(healthy.map((r) => r.tool))];
      snapshot({ env, tools });
      log(dim(`snapshot updated: ${healthy.map((r) => r.id).join(', ')}`));
    }
  };
  const soon = () => { clearTimeout(timer); timer = setTimeout(sweep, 1500); };

  const dirs = [...new Set(targets.map((t) => path.dirname(t.file)))];
  for (const dir of dirs) {
    try {
      fs.watch(dir, (_, name) => {
        if (!name || targets.some((t) => path.basename(t.file) === name.toString())) soon();
      });
    } catch { /* the directory may not exist yet; the sweep below still covers it */ }
  }
  setInterval(sweep, 60_000);
  log(`watching ${targets.length} files; Ctrl+C to stop`);
  sweep();
}

export async function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (err) { console.error(red(err.message)); console.error('Run `agentkeep --help`.'); return 1; }
  if (o.help || !o.cmd) { console.log(HELP); return o.cmd || o.help ? 0 : 1; }
  const out = (v) => console.log(JSON.stringify(v, null, 2));
  try {
    switch (o.cmd) {
      case 'snapshot': {
        const rep = snapshot({ tools: o.tools, force: o.force });
        o.json ? out(rep) : printSnapshot(rep);
        return rep.some((r) => r.state === 'damaged') ? 2 : 0;
      }
      case 'check': {
        const res = check({ tools: o.tools });
        if (o.json) out({ ...res, results: res.results.map(redact) });
        else printCheck(res);
        return res.results.some(isDamaged) ? 2 : 0;
      }
      case 'restore': {
        const rep = restore({ tools: o.tools, changed: o.changed, dryRun: o.dryRun });
        o.json ? out(rep) : printRestore(rep, o.dryRun);
        return rep.some((r) => r.action === 'skipped') ? 1 : 0;
      }
      case 'watch':
        watch(o);
        return new Promise(() => {});
      default:
        console.error(red(`unknown command ${o.cmd}`));
        console.error('Run `agentkeep --help`.');
        return 1;
    }
  } catch (err) {
    console.error(red(err.message));
    return 1;
  }
}

function redact(r) {
  const d = (x) => ({ path: x.path, ...('was' in x ? { was: describe(x.path, x.was) } : {}), ...('now' in x ? { now: describe(x.path, x.now) } : {}) });
  return { ...r, missing: r.missing.map(d), emptied: r.emptied.map(d), changed: r.changed.map(d), added: r.added.map(d) };
}
