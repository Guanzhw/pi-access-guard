// === 权限动作 ===
export type Action = "allow" | "ask" | "deny";

// === 预设名称 ===
export type PresetName = "isolated" | "standard" | "trusted";

// === 工具规则 ===
// 单个工具的规则：可以是全局 Action 或按模式细分
export type ToolRules = Action | Record<string, Action>;
// 所有工具的规则集合
export type Rules = Action | Record<string, ToolRules>;

// === 匹配器类型 ===
export type MatcherType = "bash" | "glob" | "exact";
export interface Matcher {
  param: string;   // 从 event.input 提取的参数名
  type: MatcherType;
}
export type Matchers = Record<string, Matcher>;

// === Profile ===
export type Profile = Rules;

// === 审计配置 ===
export interface AuditConfig {
  enabled: boolean;
  path: string;
  maxSizeMb: number;
  includeInputs: boolean;
}

// === 审计条目 ===
export interface AuditEntry {
  ts: string;            // ISO 8601
  tool: string;
  action: Action | "forbidden_path" | "outside_workspace" | "forbidden_command";
  reason: string;
  path?: string;         // 涉及的文件路径
  command?: string;      // bash 命令（如果 includeInputs）
  cwd?: string;
}

// === 执行结果审计条目 ===
export interface ExecutionAuditEntry {
  ts: string;
  tool: string;
  success: boolean;
  toolCallId: string;
}

// === 完整配置 ===
export interface GuardConfig {
  enabled: boolean;
  preset: PresetName;
  workspaces: string[];        // 绝对路径
  workspaceOnly: boolean;
  forbiddenPaths: string[];    // 全局禁止路径（glob）
  envPassthrough: string[];    // 环境变量白名单
  allowedCommands: string[];   // 空 = 使用预设
  forbiddenCommands: string[]; // 永远禁止的命令名
  matchers: Matchers;
  rules: Rules;
  profiles: Record<string, Profile>;
  shortcuts: Record<string, string>;
  audit: AuditConfig;
}

// === 策略裁决上下文 ===
export interface PolicyContext {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  config: GuardConfig;
  effectiveRules: Rules;
}

// === 裁决结果 ===
export interface PolicyResult {
  action: Action;
  reason: string;
  mutatedInput?: Record<string, unknown>; // 修改后的 tool input
}

// === Bash 命令引用（Phase 2 将使用 unbash 类型） ===
export interface CommandRef {
  node: any; // import("unbash/dist/types").Command — Phase 2 细化
  source: string;
}
