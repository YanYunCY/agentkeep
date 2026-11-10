import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as TOML from 'smol-toml';
import { check, isDamaged, restore, snapshot } from '../src/core.js';
import { describe as describeValue } from '../src/cli.js';

let home, env;
const p = (...a) => path.join(home, ...a);
const write = (rel, text) => { fs.mkdirSync(path.dirname(p(rel)), { recursive: true }); fs.writeFileSync(p(rel), text); };
const read = (rel) => fs.readFileSync(p(rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

const CLAUDE = {
  model: 'opus',
  env: { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: 'sk-secret-123' },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] },
  permissions: { allow: ['Bash(git status)'] },
  feedbackSurveyState: { lastShown: 1 },
};
const CODEX = `# my codex config
model = "gpt-6"   # keep this
approval_policy = "on-request"

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]

[mcp_servers.github]
command = "gh-mcp"

[tui]
theme = "dark"
`;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeep-'));
  env = { AGENTKEEP_HOME: home };
  write('.claude/settings.json', JSON.stringify(CLAUDE, null, 2) + '\n');
  write('.claude.json', JSON.stringify({ numStartups: 5, mcpServers: { box: { type: 'http', url: 'https://box' } } }, null, 2));
  write('.codex/config.toml', CODEX);
  write('.gemini/settings.json', JSON.stringify({ mcpServers: { fs: { command: 'fs-mcp' } } }, null, 4) + '\n');
  snapshot({ env });
});

const result = (id) => check({ env }).results.find((r) => r.id === id);

test('a clean setup checks clean', () => {
  for (const r of check({ env }).results) {
    assert.equal(isDamaged(r), false, r.id);
    assert.equal(r.changed.length, 0, r.id);
  }
});

test('noise the tool writes itself is ignored', () => {
  const c = json('.claude/settings.json');
  c.feedbackSurveyState = { lastShown: 99 };
  write('.claude/settings.json', JSON.stringify(c, null, 2));
  const s = json('.claude.json');
  s.numStartups = 6;
  write('.claude.json', JSON.stringify(s, null, 2));
  for (const r of check({ env }).results) assert.equal(isDamaged(r) || r.changed.length > 0, false, r.id);
});

test('a removed hook and an emptied env var are reported and restored, nothing else is touched', () => {
  const c = json('.claude/settings.json');
  delete c.hooks.Stop;
  c.env.ANTHROPIC_BASE_URL = '';
  c.model = 'sonnet'; // a deliberate change
  c.feedbackSurveyState = { lastShown: 42 };
  write('.claude/settings.json', JSON.stringify(c, null, 2) + '\n');

  const r = result('claude/settings');
  assert.deepEqual(r.missing.map((d) => d.path), [['hooks', 'Stop']]);
  assert.deepEqual(r.emptied.map((d) => d.path), [['env', 'ANTHROPIC_BASE_URL']]);
  assert.deepEqual(r.changed.map((d) => d.path), [['model']]);

  const [rep] = restore({ env, tools: ['claude'] }).filter((x) => x.id === 'claude/settings');
  assert.equal(rep.action, 'patched');
  assert.ok(fs.existsSync(rep.backup));
  const after = json('.claude/settings.json');
  assert.deepEqual(after.hooks, CLAUDE.hooks);
  assert.equal(after.env.ANTHROPIC_BASE_URL, 'https://relay.example');
  assert.equal(after.model, 'sonnet', 'a changed value is kept without --changed');
  assert.deepEqual(after.feedbackSurveyState, { lastShown: 42 });
  assert.ok(read('.claude/settings.json').endsWith('}\n'));
});

test('--changed also undoes changed values', () => {
  const c = json('.claude/settings.json');
  c.model = 'sonnet';
  write('.claude/settings.json', JSON.stringify(c, null, 2));
  restore({ env, tools: ['claude'], changed: true });
  assert.equal(json('.claude/settings.json').model, 'opus');
});

test('dry run changes nothing', () => {
  write('.gemini/settings.json', '{}');
  const [rep] = restore({ env, tools: ['gemini'], dryRun: true });
  assert.equal(rep.action, 'planned');
  assert.equal(read('.gemini/settings.json'), '{}');
});

test('a deleted file is put back from the snapshot copy', () => {
  fs.rmSync(p('.gemini/settings.json'));
  assert.equal(result('gemini/settings').state, 'missing');
  assert.equal(isDamaged(result('gemini/settings')), true);
  const [rep] = restore({ env, tools: ['gemini'] });
  assert.equal(rep.action, 'replaced');
  assert.deepEqual(json('.gemini/settings.json'), { mcpServers: { fs: { command: 'fs-mcp' } } });
});

test('a blank file is backed up, then replaced', () => {
  write('.gemini/settings.json', '\n');
  const [rep] = restore({ env, tools: ['gemini'] });
  assert.equal(rep.action, 'replaced');
  assert.equal(fs.readFileSync(rep.backup, 'utf8'), '\n');
});

test('a corrupt file is never overwritten', () => {
  write('.gemini/settings.json', '{"mcpServers": {');
  assert.equal(result('gemini/settings').state, 'unreadable');
  const [rep] = restore({ env, tools: ['gemini'] });
  assert.equal(rep.action, 'skipped');
  assert.equal(read('.gemini/settings.json'), '{"mcpServers": {');
});

test('a JSONC file with comments is never overwritten', () => {
  const text = '{\n  // my servers\n  "mcpServers": {}\n}\n';
  write('.gemini/settings.json', text);
  assert.equal(result('gemini/settings').state, 'unsupported');
  assert.equal(restore({ env, tools: ['gemini'] })[0].action, 'skipped');
  assert.equal(read('.gemini/settings.json'), text);
});

test('a lost MCP server in config.toml comes back with comments kept', () => {
  write('.codex/config.toml', CODEX.replace('[mcp_servers.github]\ncommand = "gh-mcp"\n\n', ''));
  const r = result('codex/config');
  assert.deepEqual(r.missing.map((d) => d.path), [['mcp_servers', 'github']]);
  const [rep] = restore({ env, tools: ['codex'] });
  assert.equal(rep.action, 'patched');
  assert.equal(rep.rewrote, false);
  const text = read('.codex/config.toml');
  assert.match(text, /# my codex config/);
  assert.match(text, /# keep this/);
  assert.deepEqual({ ...TOML.parse(text).mcp_servers.github }, { command: 'gh-mcp' });
  assert.deepEqual({ ...TOML.parse(text).tui }, { theme: 'dark' });
});

test('a lost top-level TOML key goes above the first table', () => {
  write('.codex/config.toml', CODEX.replace('approval_policy = "on-request"\n', ''));
  restore({ env, tools: ['codex'] });
  const text = read('.codex/config.toml');
  assert.equal(TOML.parse(text).approval_policy, 'on-request');
  assert.ok(text.indexOf('approval_policy') < text.indexOf('[mcp_servers.docs]'));
});

test('an emptied TOML value is restored by a rewrite, and says so', () => {
  write('.codex/config.toml', CODEX.replace('model = "gpt-6"', 'model = ""'));
  const [rep] = restore({ env, tools: ['codex'] });
  assert.equal(rep.action, 'patched');
  assert.equal(rep.rewrote, true);
  assert.equal(TOML.parse(read('.codex/config.toml')).model, 'gpt-6');
});

test('CRLF line endings and indentation are kept', () => {
  write('.gemini/settings.json', '{\r\n    "mcpServers": {}\r\n}\r\n');
  restore({ env, tools: ['gemini'] });
  const text = read('.gemini/settings.json');
  assert.ok(text.includes('\r\n    "mcpServers"'));
  assert.ok(!/[^\r]\n/.test(text));
});

test('snapshot refuses to save over a good one with lost settings', () => {
  write('.gemini/settings.json', '{}');
  const [rep] = snapshot({ env, tools: ['gemini'] });
  assert.equal(rep.state, 'damaged');
  assert.equal(isDamaged(result('gemini/settings')), true, 'old snapshot is kept');
  snapshot({ env, tools: ['gemini'], force: true });
  assert.equal(isDamaged(result('gemini/settings')), false);
});

test('a missing tool is just not installed', () => {
  fs.rmSync(p('.gemini'), { recursive: true });
  fs.rmSync(p('.agentkeep'), { recursive: true });
  const [rep] = snapshot({ env, tools: ['gemini'] });
  assert.equal(rep.state, 'missing');
  assert.equal(check({ env, tools: ['gemini'] }).results[0].state, 'missing');
});

test('secrets are never printed', () => {
  assert.doesNotMatch(describeValue(['env', 'ANTHROPIC_AUTH_TOKEN'], 'sk-secret-123'), /secret-123/);
  assert.doesNotMatch(describeValue(['model_providers', 'x', 'api_key'], 'sk-1'), /sk-1/);
  assert.equal(describeValue(['model'], 'opus'), '"opus"');
});

test('the CLI check exits 2 on lost settings and never prints the token', () => {
  const c = json('.claude/settings.json');
  delete c.env.ANTHROPIC_AUTH_TOKEN;
  write('.claude/settings.json', JSON.stringify(c));
  const bin = path.join(import.meta.dirname, '..', 'bin', 'agentkeep.js');
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [bin, 'check'], { env: { ...process.env, ...env, NO_COLOR: '1' }, encoding: 'utf8' });
  } catch (err) {
    out = err.stdout; code = err.status;
  }
  assert.equal(code, 2);
  assert.match(out, /removed\s+env\.ANTHROPIC_AUTH_TOKEN/);
  assert.doesNotMatch(out, /sk-secret-123/);
});

test('mixed line endings follow the majority', async () => {
  const { eolOf } = await import('../src/formats.js');
  assert.equal(eolOf('a\nb\nc\r\n'), '\n');
  assert.equal(eolOf('a\r\nb\r\nc\n'), '\r\n');
  const text = 'model = "gpt-6"\nnotify = ["x"]\n\n[tui]\ntheme = "dark"\r\n';
  write('.codex/config.toml', text);
  snapshot({ env, tools: ['codex'], force: true });
  write('.codex/config.toml', text.replace('notify = ["x"]\n', ''));
  restore({ env, tools: ['codex'] });
  assert.equal(read('.codex/config.toml'), text.replace('notify = ["x"]', 'notify = [ "x" ]'));
});

test('a restored JSON key goes back where it was', () => {
  const orig = { a: 1, hooks: { Pre: [1], Mid: [2], Post: [3] }, z: 2 };
  write('.gemini/settings.json', JSON.stringify(orig, null, 2) + '\n');
  snapshot({ env, tools: ['gemini'], force: true });
  write('.gemini/settings.json', JSON.stringify({ a: 1, z: 2 }, null, 2) + '\n');
  restore({ env, tools: ['gemini'] });
  assert.equal(read('.gemini/settings.json'), JSON.stringify(orig, null, 2) + '\n');
});

test('NO_COLOR and FORCE_COLOR follow the usual conventions', async () => {
  const { useColor } = await import('../src/cli.js');
  assert.equal(useColor({}, true), true);
  assert.equal(useColor({}, false), false);
  assert.equal(useColor({ NO_COLOR: '1' }, true), false);
  assert.equal(useColor({ NO_COLOR: '' }, true), true, 'empty NO_COLOR does not disable, per no-color.org');
  assert.equal(useColor({ FORCE_COLOR: '1' }, false), true);
  assert.equal(useColor({ FORCE_COLOR: '0' }, true), false);
  assert.equal(useColor({ FORCE_COLOR: 'false' }, true), false);
  assert.equal(useColor({ FORCE_COLOR: '' }, false), false);
  assert.equal(useColor({ NO_COLOR: '1', FORCE_COLOR: '1' }, false), false);
});
