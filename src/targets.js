// Which files agentkeep looks after, and which settings in them.
//
// A watch entry is a dotted path. "x.*" means every child of x is protected
// on its own, so one MCP server or one hook event can be put back without
// touching the others. Settings the tools rewrite themselves all the time
// (startup counters, caches, tips, UI state) are left out on purpose.

import os from 'node:os';
import path from 'node:path';

export function homeDir(env = process.env) {
  return env.AGENTKEEP_HOME || os.homedir();
}

export function storeDir(env = process.env) {
  return env.AGENTKEEP_DIR || path.join(homeDir(env), '.agentkeep');
}

export function targets(env = process.env) {
  const home = homeDir(env);
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const claudeState = env.CLAUDE_CONFIG_DIR
    ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(home, '.claude.json');
  const codexDir = env.CODEX_HOME || path.join(home, '.codex');
  const geminiDir = path.join(home, '.gemini');

  return [
    {
      id: 'claude/settings',
      tool: 'claude',
      file: path.join(claudeDir, 'settings.json'),
      format: 'json',
      watch: [
        'model', 'env.*', 'hooks.*', 'permissions.*', 'statusLine',
        'enabledPlugins.*', 'extraKnownMarketplaces.*', 'apiKeyHelper',
        'outputStyle', 'mcpServers.*', 'enabledMcpjsonServers', 'disabledMcpjsonServers',
      ],
    },
    {
      // Claude Code rewrites this file constantly; only the user-scope MCP
      // servers in it are the user's own settings.
      id: 'claude/state',
      tool: 'claude',
      file: claudeState,
      format: 'json',
      watch: ['mcpServers.*'],
    },
    {
      id: 'codex/config',
      tool: 'codex',
      file: path.join(codexDir, 'config.toml'),
      format: 'toml',
      watch: [
        'model', 'model_provider', 'model_reasoning_effort', 'openai_base_url',
        'approval_policy', 'sandbox_mode', 'profile', 'notify',
        'model_providers.*', 'mcp_servers.*', 'profiles.*', 'features.*', 'hooks.*', 'plugins.*',
      ],
    },
    {
      id: 'gemini/settings',
      tool: 'gemini',
      file: path.join(geminiDir, 'settings.json'),
      format: 'json',
      watch: [
        'mcpServers.*', 'hooks.*', 'model.*', 'security.*', 'tools.*', 'context.*',
        'selectedAuthType',
      ],
    },
  ];
}

export function parseSpec(spec) {
  const each = spec.endsWith('.*');
  return { path: (each ? spec.slice(0, -2) : spec).split('.'), each };
}
