import { parse as parseBash } from "unbash";
import type { PolicyContext, PolicyResult, Action, CommandRef } from "./types";
import { normalizePath, resolveRealPathRecursive, isForbidden, isWithinWorkspaces, extractPaths, extractPrimaryPath } from "./path-resolver";
import { extractAllCommands, expandWrapperCommands, extractFilePaths, getCommandName, containsVariableReferences, isDangerousEval, wrapWithCleanEnv, buildMinimalEnv } from "./bash-parser";
import { getToolRules, resolveBashAction, resolveGlobAction } from "./matching";

/**
 * 完整的策略裁决流程。
 * 返回 { action, reason, mutatedInput? }
 */
export async function evaluatePolicy(
  ctx: PolicyContext
): Promise<PolicyResult> {
  const { toolName, input, cwd, config, effectiveRules } = ctx;

  if (!config.enabled) return { action: "allow", reason: "disabled" };

  // === 路径安全（递归符号链接解析） ===
  const paths = extractPaths(toolName, input, config.matchers);
  for (const rawPath of paths) {
    const absPath = normalizePath(rawPath, cwd);
    const realPath = resolveRealPathRecursive(absPath);

    if (isForbidden(absPath, config.forbiddenPaths) ||
        isForbidden(realPath, config.forbiddenPaths)) {
      return { action: "deny", reason: `forbidden_path: ${rawPath}` };
    }
    if (config.workspaceOnly &&
        (!isWithinWorkspaces(absPath, config.workspaces) ||
         !isWithinWorkspaces(realPath, config.workspaces))) {
      return { action: "deny", reason: `outside_workspace: ${rawPath}` };
    }
  }

  // === Bash 特化处理 ===
  let hasVariableRef = false;
  let hasDangerousEval = false;

  if (toolName === "bash" && typeof input.command === "string") {
    // 检查 bash 工具自身的 cwd 参数
    if (input.cwd && typeof input.cwd === "string") {
      const bashCwd = normalizePath(input.cwd as string, cwd);
      if (config.workspaceOnly &&
          !isWithinWorkspaces(bashCwd, config.workspaces)) {
        return { action: "deny", reason: "bash cwd outside workspace" };
      }
    }

    // 保存用户自定义 env（后续合并而非覆盖）
    const userEnv = input.env as Record<string, string> | undefined;

    // AST 解析
    let commands: CommandRef[];
    try {
      const ast = parseBash(input.command);
      commands = extractAllCommands(ast, input.command);
    } catch {
      return { action: "deny", reason: "bash_parse_failed" };
    }

    // 展开包装命令 + 检查每个子命令
    const expanded = expandWrapperCommands(commands);

    for (const cmd of expanded) {
      const name = getCommandName(cmd);

      if (config.forbiddenCommands.includes(name)) {
        return { action: "deny", reason: `forbidden_command: ${name}` };
      }
      if (config.allowedCommands.length > 0 &&
          !config.allowedCommands.includes(name)) {
        return { action: "deny", reason: `not_in_whitelist: ${name}` };
      }
      if (containsVariableReferences(cmd)) hasVariableRef = true;
      if (isDangerousEval(cmd)) hasDangerousEval = true;

      // 提取文件路径并检查 workspace/forbidden
      const bashPaths = extractFilePaths(cmd);
      for (const bp of bashPaths) {
        const absBp = normalizePath(bp, cwd);
        const realBp = resolveRealPathRecursive(absBp);
        if (isForbidden(absBp, config.forbiddenPaths) ||
            isForbidden(realBp, config.forbiddenPaths)) {
          return { action: "deny", reason: `bash_forbidden_path: ${bp}` };
        }
        if (config.workspaceOnly &&
            (!isWithinWorkspaces(absBp, config.workspaces) ||
             !isWithinWorkspaces(realBp, config.workspaces))) {
          return { action: "deny", reason: `bash_outside_workspace: ${bp}` };
        }
      }
    }

    // 环境变量过滤：修改 input.command
    const originalForAudit = input.command;
    input.command = wrapWithCleanEnv(input.command, config.envPassthrough);

    // 合并环境变量
    if (userEnv && typeof userEnv === "object") {
      (input as any).env = {
        ...buildMinimalEnv(config.envPassthrough),
        ...userEnv,
      };
    }

    // 保存原始命令用于审计
    (input as any)._originalCommand = originalForAudit;
  }

  // === 规则匹配 ===
  const toolRules = getToolRules(effectiveRules, toolName);
  let action: Action = "allow";

  if (typeof toolRules === "string") {
    action = toolRules;
  } else if (toolName === "bash" && typeof input.command === "string") {
    // 变量引用和危险求值命令强制降级为 ask
    if (hasVariableRef || hasDangerousEval) {
      action = "ask";
    } else {
      // 从 cleaned command 重新解析以获取命令名/参数
      const originalCommand = (input as any)._originalCommand as string;
      if (originalCommand) {
        try {
          const ast = parseBash(originalCommand);
          const cmds = extractAllCommands(ast, originalCommand);
          const expandedCmds = expandWrapperCommands(cmds);

          for (const cmd of expandedCmds) {
            const name = getCommandName(cmd);
            const args = cmd.node.suffix?.map((w: any) => w?.value ?? w?.text ?? "") ?? [];

            if (/^delay|^wait|^sleep|^read\b/.test(name)) continue;

            const resolved = resolveBashAction(name, args, toolRules as Record<string, Action>);
            if (resolved === "deny") {
              return { action: "deny", reason: `bash_rule: ${name}` };
            }
            if (resolved === "ask") action = "ask";
            if (resolved === "allow" && action !== "ask") action = "allow";
          }
        } catch {
          action = "ask";
        }
      }
    }
  } else {
    // Glob/exact matching
    const matcher = config.matchers[toolName];
    if (matcher) {
      const extractedPath = extractPrimaryPath(input, matcher);
      if (extractedPath) {
        const resolved = resolveGlobAction(extractedPath, toolRules as Record<string, Action>);
        if (resolved) action = resolved;
      } else {
        action = (toolRules as Record<string, Action>)["*"] ?? "ask";
      }
    } else {
      // 无 matcher 的工具：直接使用 toolRules
      if (typeof toolRules === "string") {
        action = toolRules;
      } else if (typeof toolRules === "object" && toolRules !== null) {
        action = (toolRules as Record<string, Action>)["*"] ?? "ask";
      } else {
        action = "ask";
      }
    }
  }

  return { action, reason: action, mutatedInput: input };
}
