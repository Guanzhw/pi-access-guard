import type { GuardConfig, PresetName, Rules } from "./types";

// === 预设规则定义 ===

// isolated 预设：极严格 — 只允许纯读取命令，禁止所有写入和执行
const ISOLATED_RULES: Rules = {
  read:  { "*": "allow", "**/.env*": "deny", "**/*.pem": "deny" },
  write: { "*": "deny" },
  edit:  { "*": "deny" },
  bash: {
    "*": "deny",
    // 只允许纯读取命令
    "cat": "allow", "head": "allow", "tail": "allow",
    "grep": "allow", "find": "allow", "ls": "allow",
    "wc": "allow", "sort": "allow", "uniq": "allow",
    "file": "allow", "stat": "allow", "pwd": "allow",
    "echo": "allow", "printf": "allow", "which": "allow",
    "git status": "allow", "git log": "allow",
    "git diff": "allow", "git show": "allow",
    "git blame": "allow",
    // env/printenv 在所有预设中默认 deny（防止泄露白名单中的环境变量）
    "env": "deny", "printenv": "deny",
  },
  grep:         { "*": "deny" },
  find:         { "*": "deny" },
  ls:           { "*": "deny" },
};

// standard 预设：平衡（默认）— 只读 allow，写入 ask，危险操作 deny
const STANDARD_RULES: Rules = {
  read:  { "*": "allow", "**/.env*": "deny", "**/*.pem": "deny" },
  write: { "*": "ask" },
  edit:  { "*": "ask" },
  bash: {
    "*": "ask",
    // 60+ 只读命令 allow
    "cat": "allow", "grep": "allow", "find": "allow",
    "ls": "allow", "head": "allow", "tail": "allow",
    "wc": "allow", "sort": "allow", "uniq": "allow",
    "file": "allow", "stat": "allow", "pwd": "allow",
    "echo": "allow", "printf": "allow", "which": "allow",
    "date": "allow", "basename": "allow", "dirname": "allow",
    "true": "allow", "false": "allow", "expr": "allow", "test": "allow",
    "readlink": "allow", "realpath": "allow",
    "git status": "allow", "git log": "allow", "git diff": "allow",
    "git show": "allow", "git blame": "allow", "git branch": "allow",
    "git ls-files": "allow",
    // 编译/构建命令
    "npm test": "allow", "npm run build": "ask", "npm install": "ask",
    // 解释器执行（危险求值）
    "node": "ask", "python": "ask", "python3": "ask",
    // 网络
    "curl": "ask", "wget": "ask",
    // 文件操作
    "mkdir": "ask", "cp": "ask", "mv": "ask",
    "chmod": "ask", "chown": "ask",
    // 永远禁止
    "rm": "deny", "rmdir": "deny",
    "shutdown": "deny", "reboot": "deny", "halt": "deny",
    "mkfs": "deny", "dd": "deny",
    "env": "deny", "printenv": "deny",
  },
  grep:         { "*": "allow" },
  find:         { "*": "allow" },
  ls:           { "*": "allow" },
};

// trusted 预设：宽松 — 除敏感文件外全部 allow
const TRUSTED_RULES: Rules = {
  read:  { "*": "allow", "**/.env*": "deny", "**/*.pem": "deny" },
  write: { "*": "allow" },
  edit:  { "*": "allow" },
  bash:  { "*": "allow" },
  grep:         { "*": "allow" },
  find:         { "*": "allow" },
  ls:           { "*": "allow" },
};

// 预设映射
const PRESETS: Record<PresetName, Rules> = {
  isolated: ISOLATED_RULES,
  standard: STANDARD_RULES,
  trusted:  TRUSTED_RULES,
};

export function getPresetRules(preset: PresetName): Rules {
  return PRESETS[preset];
}

// === 基础配置（所有预设共享） ===
export const BASE_CONFIG = {
  enabled: true,
  workspaceOnly: true,
  forbiddenPaths: [
    "~/.ssh/**", "~/.aws/**", "~/.gnupg/**",
    "/etc/**", "/sys/**", "/boot/**", "/proc/**",
    // Windows 系统路径（Unix 上永远不会匹配，安全）
    "C:/Windows/**", "C:/ProgramData/**",
    "C:/Program Files/**", "C:/Program Files (x86)/**",
    "**/AppData/Roaming/**",
  ],
  // envPassthrough：基础环境变量（跨平台子集）
  // Windows 用户可通过 PI_GUARD_ENV_PASSTHROUGH 添加额外变量
  // PI_GUARD_ENV_PASSTHROUGH 环境变量可以覆盖此列表
  // 列出的变量会在 bash 子进程中存在；Unix 上不存在 Windows 变量会被静默跳过，反之亦然
  envPassthrough: ["PATH", "HOME", "USER", "LANG", "USERPROFILE", "USERNAME", "TEMP", "APPDATA"],
  forbiddenCommands: ["shutdown", "reboot", "mkfs", "dd", "halt", "env", "printenv",
    // Windows 破坏性命令（可从 Git Bash 访问）
    "format", "diskpart", "wmic", "reg", "sc", "bcdedit", "icacls", "cacls", "net", "taskkill"],
  allowedCommands: [], // 空 = 使用预设规则
  // 内置工具匹配器
  matchers: {
    bash:  { param: "command", type: "bash" as const },
    read:  { param: "path",    type: "glob" as const },
    write: { param: "path",    type: "glob" as const },
    edit:  { param: "path",    type: "glob" as const },
    grep:  { param: "path",    type: "glob" as const },
    find:  { param: "path",    type: "glob" as const },
    ls:    { param: "path",    type: "glob" as const },
  },
  audit: {
    enabled: true,
    path: "~/.pi/guard-audit.jsonl",
    maxSizeMb: 50,
    includeInputs: false,
  },
};

// === 默认完整配置 ===
export const DEFAULT_CONFIG: GuardConfig = {
  ...BASE_CONFIG,
  preset: "standard",
  workspaces: ["."],
  rules: STANDARD_RULES,
  profiles: {},
  shortcuts: {},
};
