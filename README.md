# pi-access-guard

Mandatory access control extension for [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

By default, pi has unrestricted filesystem and shell access — convenient, but risky. This extension provides granular access control so pi can run directly on a personal machine without requiring container isolation. The design is inspired by [zeroclaw's access control](https://github.com/zeroclaw-labs/zeroclaw) approach.

Intercepts tool calls (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, and extension tools) and enforces a policy that returns one of three actions: **allow**, **ask** (interactive approval via TUI), or **deny** (block with reason).

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
| `isolated` | allow | deny | deny | deny (read-only commmands like cat, grep, ls allowed) | deny |
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
