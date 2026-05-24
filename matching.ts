import { minimatch } from "minimatch";

// ============ 子序列匹配 ============

/**
 * 子序列匹配：needle tokens 是否在 haystack 中顺序出现。
 * "git log" 匹配 "git log --oneline"。
 * 支持通配符 token：pattern 中的 token 含 * 或 ? 时做 glob 匹配。
 */
export function isSubsequence(needle: string[], haystack: string[]): boolean {
  let ni = 0;
  for (let hi = 0; hi < haystack.length && ni < needle.length; hi++) {
    const needleToken = needle[ni];
    if (needleToken === haystack[hi]) {
      ni++;
    } else if (needleToken.includes("*") || needleToken.includes("?")) {
      // 通配符 token 用 glob 匹配
      if (minimatch(haystack[hi], needleToken, { dot: true })) {
        ni++;
      }
    }
    // 否则不匹配，继续在 haystack 中搜索
  }
  return ni === needle.length;
}

// ============ Glob 匹配 ============

/**
 * Glob 匹配：使用 minimatch。
 * 支持 *, **, ?, ~ 展开。
 */
export function globMatch(pattern: string, input: string): boolean {
  return minimatch(input, pattern, { dot: true });
}

// ============ 规则解析 ============

/**
 * 从规则中提取工具级别的规则。
 */
export function getToolRules(
  rules: import("./types").Rules,
  toolName: string
): import("./types").ToolRules {
  if (typeof rules === "string") return rules;
  // 如果有 __fallback__ 键且当前 tool 未在 rules 中，返回 fallback
  if (toolName in rules) {
    return rules[toolName] ?? "ask";
  }
  const fallback = (rules as any)["__fallback__"];
  if (fallback !== undefined) return fallback as import("./types").ToolRules;
  return "ask";
}

// ============ 动作解析 ============

/**
 * 解析 Bash 命令的 action：
 * 规则按插入顺序评估（last match wins）。"*" 匹配任何命令。
 * 支持通配符 token：pattern 中的 token 含 * 或 ? 时做 glob 匹配。
 */
export function resolveBashAction(
  commandName: string,
  commandArgs: string[],
  rules: Record<string, import("./types").Action>
): import("./types").Action | undefined {
  // 构建完整的命令 token 列表
  const haystack = [commandName, ...commandArgs];

  // 按顺序遍历规则（最早定义的规则优先）
  // last match wins — 但我们返回第一个匹配
  // 这里的处理方式是遍历所有规则，记录最后匹配的
  let lastMatch: import("./types").Action | undefined;
  let wildcardMatch: import("./types").Action | undefined;

  for (const [pattern, action] of Object.entries(rules)) {
    if (pattern === "*") {
      wildcardMatch = action;
      continue;
    }

    if (pattern === commandName) {
      // 精确命令名匹配
      lastMatch = action;
    } else {
      // 子序列匹配
      const needle = pattern.split(/\s+/);
      if (isSubsequence(needle, haystack)) {
        lastMatch = action;
      }
    }
  }

  // 返回最后匹配（如果没匹配到则用通配符）
  return lastMatch ?? wildcardMatch;
}

/**
 * 解析 glob-based 工具的 action（read, write, edit 等）。
 * 规则按插入顺序评估，last match wins。
 */
export function resolveGlobAction(
  input: string,
  rules: Record<string, import("./types").Action>
): import("./types").Action | undefined {
  // 按顺序迭代，最后匹配的获胜
  let lastMatch: import("./types").Action | undefined;
  let wildcardMatch: import("./types").Action | undefined;

  for (const [pattern, action] of Object.entries(rules)) {
    if (pattern === "*") {
      wildcardMatch = action;
      continue;
    }

    if (globMatch(pattern, input)) {
      lastMatch = action;
    }
  }

  return lastMatch ?? wildcardMatch;
}

/**
 * 解析 exact-match 工具的 action。
 */
export function resolveExactAction(
  input: string,
  rules: Record<string, import("./types").Action>
): import("./types").Action | undefined {
  return rules[input] ?? rules["*"];
}
