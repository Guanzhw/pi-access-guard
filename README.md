# pi-access-guard

Mandatory access control extension for [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

## The problem

Before using pi, I noticed it had no security measures at all. My first instinct was to run pi inside a Docker container for isolation. But it didn't take long to realize that keeping pi in a container severely limited its usefulness in daily development — extra performance overhead, extra environment setup. The real question became: **How can I prevent pi from accidentally doing something destructive**, while keeping it running directly on my machine?

## The approach

I had used [zeroclaw](https://github.com/zeroclaw-labs/zeroclaw) before and knew that a well-designed access control mechanism could effectively prevent accidental destructive operations from an agent. So I had pi (running in the container) study zeroclaw's design and produce a simple access guard that could work outside the container.

The result is this extension: it hooks into pi's `tool_call` events, intercepts every filesystem and shell operation, and enforces a policy that returns one of three actions: **allow**, **ask** (interactive approval via TUI), or **deny** (block with reason).

## ⚠️ Disclaimer

I've been using this extension in my own workflow for a while now, but **I do not recommend installing it and then letting pi run unattended in your working environment**. As stated above, this extension is designed to prevent accidental destructive operations **in my specific working environment** — it cannot stop a determined agent that intends to do harm.

For production-grade safety rails, refer to more mature systems like [codex](https://github.com/openai/codex) or [zeroclaw](https://github.com/zeroclaw-labs/zeroclaw).

## Takeaway

pi agent + a capable LLM (in my case, DeepSeek V4 Pro) is enough to build a usable security design. Start building your own guard!

---

## How it works

The extension hooks into pi's `tool_call` event. For each call:

1. **Path check** — resolves paths against configured workspace directories, forbidden path globs, and follows symlinks recursively to prevent escape
2. **Bash analysis** — parses the command string with `unbash` into an AST, extracts sub-commands (including chains, pipes, subshells), expands wrapper commands (`sudo`, `time`, `npx`), and checks each against rules
3. **Environment filtering** — strips all environment variables except those in the `envPassthrough` allow-list before executing bash
4. **Rule evaluation** — merges up to 7 rule layers (preset → system → user → project → env → profile → session) and matches the tool/command/path against the combined rules
5. **Decision** — allow (pass through), ask (show TUI approval prompt), or deny (block with reason)
6. **Audit** — writes the decision to a JSONL audit log

## Configuration

Config sources, from lowest to highest priority:

| Layer | Location |
|---|---|
| Preset | Code-hardcoded in `defaults.ts` — isolated / standard / trusted |
| System | Auto-generated at startup — pi's own install and user directories are always allowed |
| User | `~/.pi/agent/settings.json` → `guard` key |
| Project | `.pi/settings.json` found by walking up from cwd |
| Env | `PI_GUARD` environment variable (JSON) |
| Profile | Named profile in config, activated via `/guard profile <name>` |
| Session | Runtime rules added via `/guard session allow` |

Internal tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) cannot be overridden by user/project/env/profile/session layers — only preset rules and system rules control them.

```json
{
  "guard": {
    "preset": "standard",
    "workspaces": ["."],
    "forbiddenPaths": ["~/.ssh/**", "~/.aws/**", "/etc/**"],
    "profiles": {
      "deploy": { "bash": { "npm publish": "allow" } }
    },
    "audit": {
      "enabled": true,
      "path": "~/.pi/guard-audit.jsonl",
      "maxSizeMb": 50,
      "includeInputs": false
    }
  }
}
```

### Environment overrides

| Variable | Effect |
|---|---|
| `PI_GUARD` | JSON object merged into config at env layer |
| `PI_GUARD_ENV_PASSTHROUGH` | Comma-separated list of env var names to allow in bash subprocesses (overrides `envPassthrough`) |

## Presets

| Preset | read | write | edit | bash | Default for tools without rules |
|---|---|---|---|---|---|
| `isolated` | allow | deny | deny | deny (read-only commands like cat, grep, ls allowed) | deny |
| `standard` | allow | ask | ask | allow for 60+ read commands, ask for write commands, deny for destructive commands (rm, shutdown, dd) | ask |
| `trusted` | allow | allow | allow | allow | allow |

All presets deny access to `~/.ssh/**`, `~/.aws/**`, `~/.gnupg/**`, `/etc/**`, `/sys/**`, `/boot/**`, `/proc/**`, `**/.env*`, `**/*.pem`.

## Runtime commands

All accessible via `/guard <subcommand>`:

| Command | Effect |
|---|---|
| `status` | Print current configuration and audit stats |
| `enable` / `disable` | Toggle guard on/off |
| `preset <name>` | Switch to isolated / standard / trusted |
| `profile <name\|off>` | Activate or deactivate a named profile |
| `session allow <tool> <pattern>` | Add a temporary session-scoped allow rule |
| `audit` | Show last 20 audit entries |
| `audit clear` | Delete all audit entries |

## Files

| File | Purpose |
|---|---|
| `index.ts` | Extension entry point — hooks `tool_call` and `tool_result` events |
| `config.ts` | Configuration loading, merging, validation |
| `defaults.ts` | Built-in preset rules and base config |
| `policy.ts` | Policy evaluation engine |
| `types.ts` | Type definitions |
| `matching.ts` | Glob, subsequence, and exact pattern matching |
| `path-resolver.ts` | Path normalization, symlink resolution, workspace checks |
| `bash-parser.ts` | Bash AST extraction, command expansion, env wrapping |
| `handlers.ts` | Interactive TUI approval handlers |
| `prompt.ts` | Approval prompt text builders |
| `commands.ts` | `/guard` command registration and handlers |
| `audit.ts` | JSONL audit log with rotation |

## License

MIT
