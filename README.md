# pi-access-guard

**Lightweight, cross-platform security guard for [pi coding agent](https://github.com/earendil-works/pi-coding-agent).**

`pi-access-guard` is a mandatory access control (MAC) extension for pi. It intercepts every tool call the AI makes and enforces a configurable security policy — **allow**, **ask** (interactive approval), or **deny** — based on layered rules, AST-level bash parsing, and symlink-aware path security.

---

## Features

- 🛡️ **Three presets**: `isolated` (read-only), `standard` (default, balanced), `trusted` (permissive)
- 🔍 **AST-level bash parsing**: parses commands with `unbash` to inspect sub-commands, file paths, and dangerous patterns
- 📁 **Path security**: workspace boundaries + forbidden path patterns + recursive symlink resolution
- 🔒 **Environment sanitization**: only whitelisted env vars pass through to subprocesses
- 🤝 **Interactive approval**: TUI prompts for unapproved operations
- 📋 **Audit logging**: JSONL audit trail with auto-rotation at 50MB
- 🎛️ **Runtime control**: `/guard` command family (status, enable, disable, preset, profile, session, audit)
- 🧩 **Multi-layer policy**: preset → system → user → project → env → profile → session rules

---

## Installation

Place in pi's extension directory (typically `~/.pi/agent/extensions/access-guard/`) and it will be auto-discovered.

## Configuration

Edit `~/.pi/agent/settings.json`:

```json
{
  "guard": {
    "preset": "standard",
    "workspaces": ["."],
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

Or set per-project in `.pi/settings.json` at your project root.

### Environment overrides

| Variable | Purpose |
|---|---|
| `PI_GUARD` | JSON config overrides |
| `PI_GUARD_ENV_PASSTHROUGH` | Comma-separated env vars to allow in bash subprocesses |

---

## Presets

| Preset | read | write/edit | bash | Use case |
|---|---|---|---|---|
| `isolated` | ✅ allow | ❌ deny | ❌ deny (read-only cmds) | Sandbox |
| `standard` | ✅ allow | ⚠️ ask | Mixed | Everyday |
| `trusted` | ✅ allow | ✅ allow | ✅ allow (+ forbidden paths still blocked) | Development |

---

## Runtime commands

| Command | Action |
|---|---|
| `/guard status` | Show current state and stats |
| `/guard enable` / `/guard disable` | Toggle guard on/off |
| `/guard preset <name>` | Switch preset (isolated / standard / trusted) |
| `/guard profile <name\|off>` | Activate/deactivate a profile |
| `/guard session allow <tool> <pattern>` | Add a temporary session allow rule |
| `/guard audit` | Show recent audit entries |
| `/guard audit clear` | Clear audit log |

---

## Architecture

```
Tool call
  │
  ▼
tool_call event handler
  │
  ├─ 1. Path security (forbidden paths, workspace, symlinks)
  ├─ 2. Bash AST parsing (sub-commands, env sanitization, dangerous eval)
  ├─ 3. Rule evaluation (7-layer priority merge)
  ├─ 4. Decision: allow / deny / ask (interactive)
  └─ 5. Audit logging
```

---

## License

MIT
