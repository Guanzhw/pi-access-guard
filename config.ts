import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { GuardConfig, PresetName, Rules, ToolRules, Action } from "./types";
import { DEFAULT_CONFIG } from "./defaults";

// ============ 配置加载 ============

/**
 * 加载 ~/.pi/agent/settings.json 中的 guard 配置
 */
function loadUserSettings(config: Partial<GuardConfig>): Partial<GuardConfig> {
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    if (raw?.guard && typeof raw.guard === "object") {
      return raw.guard as Partial<GuardConfig>;
    }
  } catch {
    // 文件不存在或解析失败，忽略
  }
  return {};
}

/**
 * 加载 .pi/settings.json 项目级配置
 */
function loadProjectSettings(cwd: string): Partial<GuardConfig> | null {
  const projectConfigPath = path.join(cwd, ".pi", "settings.json");
  try {
    const raw = JSON.parse(fs.readFileSync(projectConfigPath, "utf-8"));
    if (raw?.guard && typeof raw.guard === "object") {
      return raw.guard as Partial<GuardConfig>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 从 PI_GUARD 环境变量加载配置
 * 格式：JSON 字符串（覆盖部分字段）
 */
function loadEnvConfig(): Partial<GuardConfig> | undefined {
  const raw = process.env["PI_GUARD"];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Partial<GuardConfig>;
    }
  } catch {
    // 解析失败，忽略
  }
  return undefined;
}

/**
 * 验证配置的合法性
 */
function validateConfig(input: unknown): { config: GuardConfig; warnings: string[] } {
  const warnings: string[] = [];
  const obj = (input ?? {}) as Record<string, unknown>;

  // 验证 preset
  const preset = (obj.preset ?? "standard") as PresetName;
  if (!["isolated", "standard", "trusted"].includes(preset)) {
    warnings.push(`Invalid preset "${preset}", falling back to "standard"`);
    (obj as any).preset = "standard";
  }

  // 验证 workspaces
  if (obj.workspaces !== undefined) {
    const workspaces = obj.workspaces as string[];
    for (const ws of workspaces) {
      if (ws === ".") continue; // 运行时解析
      const abs = path.resolve(ws);
      try {
        if (!fs.statSync(abs).isDirectory()) {
          warnings.push(`Workspace path "${ws}" is not a directory`);
        }
      } catch {
        warnings.push(`Workspace path "${ws}" does not exist or is not accessible`);
      }
    }
  }

  // 验证 forbiddenPaths（必须是合法 glob pattern）
  if (obj.forbiddenPaths !== undefined) {
    const fPaths = obj.forbiddenPaths as string[];
    for (const fp of fPaths) {
      if (typeof fp !== "string") {
        warnings.push(`forbiddenPaths entry is not a string: ${JSON.stringify(fp)}`);
      }
    }
  }

  // 验证 envPassthrough（不能包含 KEY/TOKEN/SECRET/PASSWORD 后缀）
  if (obj.envPassthrough !== undefined) {
    const envPt = obj.envPassthrough as string[];
    for (const v of envPt) {
      if (/_(KEY|TOKEN|SECRET|PASSWORD)$/i.test(v)) {
        warnings.push(
          `envPassthrough "${v}" looks like a secret — auto-removed for safety`
        );
      }
    }
  }

  // 验证 rules 的 action 值
  if (obj.rules !== undefined) {
    checkRules(obj.rules as Rules, warnings, "rules");
  }

  // 验证 profiles
  if (obj.profiles !== undefined) {
    const profiles = obj.profiles as Record<string, unknown>;
    for (const [name, profileRules] of Object.entries(profiles)) {
      checkRules(profileRules as Rules, warnings, `profiles.${name}`);
    }
  }

  // 合并验证后的配置
  // 用户 workspaces 始终与默认的 "." 合并，不可替换（防止误删 cwd 的 workspace）
  const mergedWorkspaces = obj.workspaces !== undefined
    ? [...new Set([...(DEFAULT_CONFIG.workspaces ?? ["."]), ...(obj.workspaces as string[])])]
    : undefined;

  const config: GuardConfig = {
    ...DEFAULT_CONFIG,
    ...obj,
    ...(mergedWorkspaces ? { workspaces: mergedWorkspaces } : {}),
    preset: (obj.preset ?? "standard") as PresetName,
  } as GuardConfig;

  return { config, warnings };
}

/**
 * 递归检查 rules 中的 action 值
 */
function checkRules(rules: Rules, warnings: string[], prefix: string): void {
  if (typeof rules === "string") {
    if (!["allow", "ask", "deny"].includes(rules)) {
      warnings.push(`${prefix}: invalid action "${rules}"`);
    }
    return;
  }
  for (const [key, value] of Object.entries(rules)) {
    if (typeof value === "string") {
      if (!["allow", "ask", "deny"].includes(value)) {
        warnings.push(`${prefix}.${key}: invalid action "${value}"`);
      }
    } else if (typeof value === "object" && value !== null) {
      checkRules(value as Rules, warnings, `${prefix}.${key}`);
    }
  }
}

/**
 * 从 PI_GUARD_ENV_PASSTHROUGH 环境变量加载 envPassthrough 覆盖
 */
function loadEnvPassthroughOverride(): string[] | undefined {
  const raw = process.env["PI_GUARD_ENV_PASSTHROUGH"];
  if (!raw) return undefined;
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

// ============ 配置合并 ============

/**
 * 合并多层规则。
 * 规则按插入顺序评估（last match wins）。
 * - 如果 layer 是 string（全局 action），整体替换
 * - 否则逐工具合并，每层内 pattern 级别覆盖
 */
function mergeRules(layers: Rules[]): Rules {
  // 从第一个有效值开始
  let result: Rules = "ask";

  for (const layer of layers) {
    if (layer === undefined || layer === null) continue;

    if (typeof layer === "string") {
      // 全局 action 替换全部
      result = layer;
    } else if (typeof result === "string") {
      // 当前结果是全局 action，需要展开为 Record
      // 用 __fallback__ 键保存全局默认值，供未在 layer 中出现的工具使用
      const currentFallback = result as string;
      const recordResult: Record<string, any> = {
        __fallback__: currentFallback,
      };
      result = recordResult as unknown as Rules;
      for (const [tool, toolRules] of Object.entries(layer)) {
        if (typeof toolRules === "string") {
          (result as Record<string, ToolRules>)[tool] = toolRules;
        } else {
          // 保留全局 fallback 作为 "*" 通配符，具体规则覆盖
          (result as Record<string, ToolRules>)[tool] = { "*": currentFallback as any, ...toolRules };
        }
      }
    } else {
      // 两者都是 Record
      for (const [tool, toolRules] of Object.entries(layer)) {
        if (typeof toolRules === "string") {
          (result as Record<string, ToolRules>)[tool] = toolRules;
        } else {
          const existing = (result as Record<string, ToolRules>)[tool];
          if (typeof existing === "string") {
            // 现有的是全局 action，保留为 "*" 通配符，新规则覆盖
            (result as Record<string, ToolRules>)[tool] = { "*": existing, ...toolRules };
          } else if (existing && typeof existing === "object") {
            // 合并 pattern
            (result as Record<string, ToolRules>)[tool] = { ...existing, ...toolRules };
          } else {
            (result as Record<string, ToolRules>)[tool] = { ...toolRules };
          }
        }
      }
    }
  }

  return result;
}

const INTERNAL_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

/**
 * 从 Rules 中移除内部工具条目
 * 用户设置层（userRules/projectRules/envRules/profileRules/sessionRules）
 * 不得覆盖代码硬编码的内部工具规则。
 */
function stripInternalTools(rules: Rules): Rules {
  if (typeof rules === "string") return rules;
  const filtered: Record<string, ToolRules> = {};
  for (const [tool, toolRules] of Object.entries(rules)) {
    if (!INTERNAL_TOOLS.has(tool)) {
      filtered[tool] = toolRules;
    }
  }
  return filtered as unknown as Rules;
}

/**
 * 预设 → 未映射工具的默认动作。
 * 当工具名称不在任何规则层中时，使用此默认值。
 */
const PRESET_FALLBACKS: Record<PresetName, Action> = {
  isolated: "deny",
  standard: "ask",
  trusted:  "allow",
};

/**
 * 构建生效规则（合并所有层）
 * 优先级从低到高：
 *   presetRules < systemRules < strippedUserLayers
 *
 * 内部工具（read/write/edit/bash/grep/find/ls）只能由 presetRules（代码硬编码）
 * 和 systemRules（代码生成的系统规则）控制。用户设置层不得覆盖它们。
 *
 * 未在任何层中出现的工具名称（如扩展工具 web_search, fetch_content 等）
 * 使用 preset 对应的默认 fallback：
 *   isolated → deny | standard → ask | trusted → allow
 */
function buildEffectiveRules(
  preset: PresetName,
  presetRules: Rules,
  systemRules: Rules | undefined,
  userRules: Rules,
  projectRules: Rules,
  envRules: Rules | undefined,
  profileRules: Rules | undefined,
  sessionRules: Record<string, Record<string, string>>,
): Rules {
  const layers: Rules[] = [
    presetRules,
  ];

  if (systemRules !== undefined) layers.push(systemRules);

  // 用户设置层：移除内部工具条目，防止外部覆盖
  layers.push(stripInternalTools(userRules));
  layers.push(stripInternalTools(projectRules));

  if (envRules !== undefined) layers.push(stripInternalTools(envRules));
  if (profileRules !== undefined) layers.push(stripInternalTools(profileRules));

  // sessionRules 是 Record<string, Record<string, string>>，转换为 Rules
  if (Object.keys(sessionRules).length > 0) {
    const sessionAsRules: Record<string, ToolRules> = {};
    for (const [tool, patterns] of Object.entries(sessionRules)) {
      if (INTERNAL_TOOLS.has(tool)) continue; // 会话命令也不能覆盖内部工具
      sessionAsRules[tool] = { ...patterns as Record<string, Action> };
    }
    if (Object.keys(sessionAsRules).length > 0) {
      layers.push(sessionAsRules);
    }
  }

  const merged = mergeRules(layers);

  // 如果最终结果是 Record（非全局 action 字符串），
  // 将 __fallback__ 替换为 preset 对应的默认值
  if (typeof merged !== "string") {
    (merged as any).__fallback__ = PRESET_FALLBACKS[preset];
  }

  return merged;
}

// ============ 保存配置 ============

/**
 * 保存配置到 ~/.pi/agent/settings.json 的 guard 键
 */
function saveConfig(config: GuardConfig): void {
  const settingsDir = path.join(os.homedir(), ".pi", "agent");
  const settingsPath = path.join(settingsDir, "settings.json");

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    // 文件不存在
  }

  settings.guard = config;

  // 确保目录存在
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

// ============ 主加载函数 ============

/**
 * 加载全局配置（所有层合并完成）
 * 返回生效配置 + 原始用户规则 + env 规则 + 警告
 */
function loadConfig(): {
  config: GuardConfig;
  userRules?: Rules;
  envRules?: Rules;
  warnings: string[];
} {
  const warnings: string[] = [];

  // 1. 从默认开始
  let merged: Partial<GuardConfig> = {};

  // 2. 用户全局设置 — 保存原始 rules 用于分层合并
  const userCfg = loadUserSettings(merged);
  const rawUserRules: Rules | undefined = userCfg.rules as Rules | undefined;
  merged = { ...merged, ...userCfg };

  // 3. 环境变量 passthrough 覆盖
  const envPassthroughOverride = loadEnvPassthroughOverride();
  if (envPassthroughOverride) {
    merged.envPassthrough = envPassthroughOverride;
  }

  // 4. 环境变量 PI_GUARD 配置
  const envCfg = loadEnvConfig();
  if (envCfg) {
    merged = { ...merged, ...envCfg };
  }

  // 5. 验证
  const { config: validated, warnings: valWarnings } = validateConfig(merged);
  warnings.push(...valWarnings);

  // 6. 提取 envRules（如果 PI_GUARD 中有 rules）
  let envRules: Rules | undefined;
  if (envCfg?.rules) {
    envRules = envCfg.rules as Rules;
  }

  return { config: validated, userRules: rawUserRules, envRules, warnings };
}

/**
 * 加载项目级配置
 */
function loadProjectConfig(cwd: string): {
  config: Partial<GuardConfig>;
  warnings: string[];
} | null {
  const warnings: string[] = [];

  // 查找包含 .pi/settings.json 的项目根目录
  let current = path.resolve(cwd);
  const root = path.parse(current).root;

  while (current !== root) {
    const projectCfg = loadProjectSettings(current);
    if (projectCfg) {
      // 项目级 workspaces 也与默认的 "." 合并，防止误删
      if (projectCfg.workspaces !== undefined) {
        projectCfg.workspaces = [...new Set([".", ...projectCfg.workspaces])];
      }
      return { config: projectCfg, warnings };
    }
    current = path.dirname(current);
  }

  return null;
}

export {
  loadConfig,
  loadProjectConfig,
  buildEffectiveRules,
  saveConfig,
  validateConfig,
  mergeRules,
};
