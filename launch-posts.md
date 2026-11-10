# agentkeep 发布文案

把 `<repo>` 换成真实的 GitHub 地址再发。

---

## 1. Show HN

**标题**（80 字符以内）

```
Show HN: Agentkeep – put back the settings Claude Code/Codex updates wipe
```

**正文**

```
I use Claude Code, Codex and Gemini CLI side by side, and every few weeks one
of them loses part of its config after an update or a migration: a hook, an
MCP server, the env block that points it at my provider. I usually find out
mid-task, when something quietly stops working.

agentkeep is a small CLI that snapshots the settings that matter in those
files, shows what went missing, and puts it back:

  npx agentkeep snapshot   # once, while everything works
  npx agentkeep check      # what was removed, emptied or changed
  npx agentkeep restore    # back up the file, put the lost settings back
  npx agentkeep watch      # or restore automatically within seconds

Some design choices:

- It only restores settings that were removed or emptied. A value you changed
  on purpose is left alone unless you ask (--changed).
- It tracks your own settings (hooks, MCP servers, env, model providers,
  permissions), not the counters and caches the tools rewrite all the time,
  so check stays quiet unless something real changed.
- JSON keeps its indentation, line endings and key order; a restored key goes
  back where it was. Lost TOML settings are added as text, so comments in
  config.toml survive.
- Every write is backed up first and read back afterwards. Files that don't
  parse, or JSON with comments, are never overwritten.
- Values under keys like token/api_key never reach the terminal.
- If something keeps wiping a file, watch stops after one try and tells you
  instead of fighting it.

Node 18+, one dependency (a TOML parser), MIT. It's 0.1, tested on Windows
and Linux so far. I'd like to hear which other files and tools it should
cover.

<repo>
```

**发帖后**：在帖子下面以作者身份补一条评论，讲清楚动机（具体哪次更新丢了什么），并回答"为什么不用 git 管 dotfiles"：git 需要你记得去看 diff，而且会把 `.claude.json` 里大量自动写入的状态也一起记进去，agentkeep 只盯你自己配的那部分。

---

## 2. V2EX（分享创造节点）

**标题**

```
做了个小工具 agentkeep：Claude Code / Codex / Gemini CLI 升级后配置被冲掉，一条命令恢复
```

**正文**

```
同时用 Claude Code、Codex、Gemini CLI 的朋友可能遇到过：某次升级或迁移之后，
hooks 没了、MCP 服务器没了、env 里的 ANTHROPIC_BASE_URL 被清空了。
通常是干活干到一半才发现不对。

agentkeep 就是解决这个的：

    npx agentkeep snapshot   # 配置正常时存一份快照
    npx agentkeep check      # 看哪些设置被删了、清空了、改了
    npx agentkeep restore    # 先备份，再把丢的设置放回去
    npx agentkeep watch      # 后台运行，几秒内自动恢复

几个设计点：

- 默认只恢复「被删除 / 被清空」的设置，你有意改过的值不动（要改回加 --changed）
- 只盯你自己配的东西：hooks、MCP、env、模型供应商、权限、插件。
  工具自己频繁写的计数器、缓存不管，所以 check 不会乱报
- JSON 保留缩进、换行符和键的顺序；TOML 用文本方式补回，config.toml 里的注释不会丢
- 每次写之前先备份，写完读回来核对；解析不了的文件、带注释的 JSON 一律不碰
- token / api_key 这类值不会打印到终端（用中转站的朋友应该在意这一点）
- 如果有程序反复冲掉同一个文件，watch 只修一次然后报告，不跟它来回抢

Node 18+，只有一个依赖（TOML 解析），MIT。现在是 0.1，在 Windows 和 Linux 上测过。
欢迎提需求：还想让它管哪些工具、哪些文件？

<repo>
```

---

## 3. X / Twitter

**主推**（附 demo.gif）

```
Claude Code / Codex / Gemini CLI updates keep wiping my MCP servers and hooks.

So I made agentkeep:

npx agentkeep check     → what got lost
npx agentkeep restore   → put it back

Only restores what was removed or emptied. Backs up first. Never prints your API keys.

<repo>
```

**中文版**（附 demo.gif）

```
Claude Code / Codex / Gemini CLI 一升级，MCP 和 hooks 就没了？

写了个小工具 agentkeep：
npx agentkeep check   看丢了什么
npx agentkeep restore 一键放回

只恢复被删、被清空的设置，写之前先备份，不会把 API key 打到终端。

<repo>
```

---

## 4. Reddit（r/ClaudeAI、r/ChatGPTCoding）

**标题**

```
I made a small CLI that restores Claude Code / Codex / Gemini CLI settings after an update wipes them
```

正文用 Show HN 那版，把第一段改成更口语的说法，并把 GIF 放在最前面。r/ClaudeAI 不让发纯推广帖，所以要写清楚这是免费开源、自己在用的工具。

---

## 5. 在相关 issue 里回复

只回那些确实是「升级后设置丢失」、而且还没关闭的 issue，一个 issue 回一次，先给能用的绕过办法，工具链接放在最后：

```
Until this is fixed, a workaround that helped me: snapshot the settings while
they're good and restore just the lost keys after an update. I wrote a small
tool for it, `npx agentkeep check` / `npx agentkeep restore`
(<repo>), but a manual backup of ~/.claude/settings.json works too.
```

不要批量贴，也不要回已经关闭的 issue。被当成刷屏会伤害项目的名声。

---

## 发布顺序建议

1. 先推 GitHub，补好仓库描述和 topics：`claude-code` `codex` `gemini-cli` `mcp` `cli` `backup`。
2. `npm publish`，确认 `npx agentkeep check` 在一台干净机器上能直接跑。
3. 工作日北京时间晚上 9 到 11 点（美国东部上午）发 Show HN，发完前两个小时守着回评论。
4. 同一天或第二天发 V2EX 和 X。
5. 之后几天按上面第 5 条去相关 issue 里回复。
