// Builds a throwaway home with example settings, damages them the way a bad
// update does, and records the real agentkeep output (with colors) for each
// step into demo/transcript.json. render.py turns that into the README GIF.
//
//   npm run demo        # node demo/capture.mjs && python demo/render.py
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'bin', 'agentkeep.js');
const H = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeep-demo-'));
const w = (rel, v) => {
  const f = path.join(H, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n');
};

w('.claude/settings.json', {
  model: 'opus',
  env: { ANTHROPIC_BASE_URL: 'https://relay.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-demo-0000000000000000000000' },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }],
  },
  statusLine: { type: 'command', command: 'statusline.sh' },
});
w('.claude.json', { numStartups: 41, mcpServers: { github: { command: 'github-mcp' }, postgres: { command: 'pg-mcp' } } });
w('.codex/config.toml', `# my codex setup
model = "gpt-6"
model_provider = "relay"

[model_providers.relay]
base_url = "https://relay.example.com/v1"

[mcp_servers.github]
command = "github-mcp"
`);
w('.gemini/settings.json', { mcpServers: { github: { command: 'github-mcp' } } });

const env = { ...process.env, AGENTKEEP_HOME: H, FORCE_COLOR: '1' };
delete env.NO_COLOR;
const run = (args) => {
  try {
    return execFileSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
  } catch (err) {
    // check exits 2 when settings are lost; that output is what we want.
    // Anything else (a crash, no output) should stop the demo, not hide.
    if (err.status === 2 && err.stdout) return err.stdout;
    throw new Error(`agentkeep ${args.join(' ')} failed (exit ${err.status}): ${err.stderr || err.message}`);
  }
};
const steps = [];
const step = (cmd, args) => steps.push({ cmd, out: run(args).replace(/\n+$/, '').split('\n') });

step('npx agentkeep snapshot', ['snapshot']);

// What a bad update does: rewrite files with settings dropped.
const c = JSON.parse(fs.readFileSync(path.join(H, '.claude/settings.json'), 'utf8'));
delete c.hooks.PreToolUse;
c.env.ANTHROPIC_BASE_URL = '';
w('.claude/settings.json', c);
w('.claude.json', { numStartups: 42, mcpServers: {} });
w('.codex/config.toml', fs.readFileSync(path.join(H, '.codex/config.toml'), 'utf8')
  .replace('[mcp_servers.github]\ncommand = "github-mcp"\n', '').trimEnd() + '\n');
steps.push({ cmd: null, out: [], note: '# ...a few days and one CLI update later' });

step('npx agentkeep check', ['check']);
step('npx agentkeep restore', ['restore']);
step('npx agentkeep check', ['check']);

// Drop the snapshot time and the temp backup paths, which change every run,
// and the empty lines left around them.
const visible = (l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim();
for (const s of steps) {
  s.out = s.out.filter((l) => !/snapshot from|stored in|backup: /.test(l));
  while (s.out.length && visible(s.out[0]) === '') s.out.shift();
  while (s.out.length && visible(s.out.at(-1)) === '') s.out.pop();
}
fs.writeFileSync(path.join(here, 'transcript.json'), JSON.stringify(steps, null, 2) + '\n');
fs.rmSync(H, { recursive: true });
for (const s of steps) {
  console.log(s.cmd ? `$ ${s.cmd}` : s.note);
  for (const l of s.out) console.log(l);
}
