import { parse as parseBash, type Script } from "unbash";
import type { GuardConfig, CommandRef } from "./types";

// ============ 常量定义 ============

// 已知不操作文件的命令（参数中的"路径"是字符串字面量）
const SAFE_COMMANDS = new Set([
  "echo", "printf", "date", "which", "true", "false",
  "expr", "test", "basename", "dirname", "readlink", "realpath",
]);

// 已知危险命令（参数是代码而非路径，可执行任意文件访问）
// 包括 Unix 和 Windows（PowerShell/cmd）解释器
const DANGEROUS_EVAL_COMMANDS = new Set([
  "python", "python3", "node", "perl", "ruby", "php", "sh", "bash",
  "powershell", "pwsh", "cmd",
]);

// 对应 flag: -c, -e 等（表示参数是代码）
const EVAL_FLAGS = new Set(["-c", "-e", "-E", "/c", "/C", "-Command", "-EncodedCommand"]);

// 包装命令（其子命令需要被展开检查）
const WRAPPER_COMMANDS = new Set([
  "sudo", "xargs", "time", "nice", "nohup", "taskset", "ionice",
]);

// ============ AST 遍历 ============

/**
 * 递归遍历 AST 节点，收集所有 Command。
 */
function collectCommands(node: any): any[] {
  const commands: any[] = [];

  if (!node || typeof node !== "object") return commands;

  // Command 节点
  if (node.type === "Command") {
    commands.push(node);
    return commands;
  }

  // 遍历子节点
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        commands.push(...collectCommands(item));
      }
    } else if (val && typeof val === "object") {
      commands.push(...collectCommands(val));
    }
  }

  return commands;
}

/**
 * 从 Bash 命令中提取所有子命令（AST 遍历）。
 * 处理：管道 |, &&, ||, ;, $(), ``, <(), >(), heredoc,
 *       if/then/else, while/for/select, case, 函数定义
 */
export function extractAllCommands(script: Script, source: string): CommandRef[] {
  const rawCommands = collectCommands(script);

  return rawCommands.map(node => ({
    node,
    source,
  }));
}

// ============ 包装命令展开 ============

/**
 * 展开包装命令：
 * - "sudo cmd" → [sudo, cmd]
 * - "xargs cmd" → [xargs, cmd]
 * - "bash -c 'cmd'" → [bash, cmd]
 * - "time cmd" → [time, cmd]
 * - "nice cmd" → [nice, cmd]
 * - "nohup cmd" → [nohup, cmd]
 */
export function expandWrapperCommands(commands: CommandRef[]): CommandRef[] {
  const expanded: CommandRef[] = [];

  for (const cmd of commands) {
    const name = getCommandName(cmd);

    if (WRAPPER_COMMANDS.has(name) && cmd.node.suffix.length > 1) {
      // 包装命令：展开内层命令。对于 sudo rm -rf /：
      //   name = "sudo", suffix = ["rm", "-rf", "/"]
      //   innerName = "rm", innerSuffix = ["-rf", "/"]
      const innerName = cmd.node.suffix[0];
      const innerSuffix = cmd.node.suffix.slice(1);
      const innerCmd: CommandRef = {
        node: {
          type: "Command",
          name: innerName,
          suffix: innerSuffix,
          redirects: cmd.node.redirects ?? [],
        },
        source: cmd.source,
      };

      // 递归展开（处理 sudo xargs cmd 之类）
      expanded.push(...expandWrapperCommands([innerCmd]));
    }

    // 始终保留原始命令
    expanded.push(cmd);
  }

  return expanded;
}

// ============ 命令名称/参数提取 ============

/**
 * 获取命令名称（Command 节点的 name.text）。
 * unbash AST 中命令名在 name.text，suffix 只包含参数。
 */
export function getCommandName(cmd: CommandRef): string {
  const name = cmd.node.name;
  if (!name) return "";
  if (typeof name === "string") return name;
  return name.text ?? "";
}

/**
 * 获取命令参数（suffix 中的 words，每个 word 可能含 value/text）。
 */
export function getCommandArgs(cmd: CommandRef): string[] {
  const words = cmd.node.suffix;
  if (!words || words.length === 0) return [];
  return words.map((w: any) => w?.value ?? w?.text ?? "");
}

// ============ 文件路径提取 ============

/**
 * 从命令参数中提取文件路径。
 */
export function extractFilePaths(cmd: CommandRef): string[] {
  const paths: string[] = [];
  const name = getCommandName(cmd);

  // 跳过已知安全命令的参数（echo 的参数 /etc/passwd 不访问文件）
  if (SAFE_COMMANDS.has(name)) return [];

  const args = getCommandArgs(cmd);

  for (const arg of args) {
    // 跳过 flag（-x, --xxx）
    if (arg.startsWith("-")) continue;
    // 跳过赋值（KEY=value，除非看起来是绝对路径）
    if (arg.includes("=") && !arg.startsWith("/") && !arg.startsWith(".") && !arg.startsWith("~")) continue;
    // 跳过纯数字
    if (/^\d+$/.test(arg)) continue;
    // 跳过 URL
    if (/^https?:\/\//i.test(arg)) continue;
    // 跳过已知的非路径值
    if (["|", "||", "&&", ";", "&", ">", "<", ">>", "<<", "2>&1", "2>/dev/null", "/dev/null"].includes(arg)) continue;
    // 所有非 flag 参数都视为潜在路径
    paths.push(arg);
  }

  // 检查重定向目标
  if (cmd.node.redirects && Array.isArray(cmd.node.redirects)) {
    for (const redir of cmd.node.redirects) {
      if (redir.target) {
        const targetVal = redir.target?.value ?? redir.target?.text;
        if (targetVal && isNaN(Number(targetVal))) {
          // 跳过 /dev/null 和文件描述符
          if (targetVal !== "/dev/null" && !/^\d+$/.test(targetVal)) {
            paths.push(targetVal);
          }
        }
      }
    }
  }

  return paths;
}

// ============ 安全检查 ============

/**
 * 检测命令中是否包含变量引用（${VAR} 或 $VAR），
 * 这些变量的值无法静态分析 → 需降级为 ask。
 */
export function containsVariableReferences(cmd: CommandRef): boolean {
  const args = getCommandArgs(cmd);
  return args.some(arg => /\$\{?[A-Za-z_]/.test(arg));
}

/**
 * 检测命令是否是已知危险求值命令（python -c, node -e 等）。
 * 这类命令的参数是代码，可以执行任意文件访问。
 */
export function isDangerousEval(cmd: CommandRef): boolean {
  const name = getCommandName(cmd);
  if (!DANGEROUS_EVAL_COMMANDS.has(name)) return false;
  const args = getCommandArgs(cmd);
  return args.some(arg => EVAL_FLAGS.has(arg));
}

// ============ 环境变量保护 ============

/**
 * 生成 Bash 子进程的最小化环境变量。
 * 只保留 envPassthrough 白名单中的变量。
 * 额外过滤：包含 _KEY, _TOKEN, _SECRET, _PASSWORD 的变量。
 */
export function buildMinimalEnv(
  envPassthrough: string[]
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of envPassthrough) {
    // 自动过滤含敏感后缀的变量
    if (/_(KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)) continue;

    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }

  return env;
}

/**
 * 包裹 bash 命令，在干净环境中执行。
 *
 * 使用 heredoc + 单引号 EOF 标记：bash << 'PI_GUARD_EOF'
 * 单引号阻止外层 shell 做任何变量/命令展开。
 */
export function wrapWithCleanEnv(
  command: string,
  envPassthrough: string[]
): string {
  const env = buildMinimalEnv(envPassthrough);
  const envKeys = Object.keys(env);

  if (envKeys.length === 0) {
    // 没有白名单变量：完全隔离
    return `env -i bash << 'PI_GUARD_EOF'\n${command}\nPI_GUARD_EOF`;
  }

  const envVars = envKeys
    .map(k => `${k}=${JSON.stringify(env[k])}`)
    .join(" ");

  // 使用 heredoc + 单引号 EOF 标记：
  //   bash << 'PI_GUARD_EOF'   ← 单引号阻止所有变量/命令展开
  //   ...command...
  //   PI_GUARD_EOF
  return `env -i ${envVars} bash << 'PI_GUARD_EOF'\n${command}\nPI_GUARD_EOF`;
}

// ============ Bash 路径安全检查 ============

/**
 * 从 Bash 命令中提取所有可能涉及的文件路径，
 * 然后对每个路径调用 path-resolver 做安全检查。
 * 返回违规路径列表（空数组 = 全部通过）。
 */
export function checkBashPathSafety(
  rawCommand: string,
  config: GuardConfig,
  cwd: string
): string[] {
  const violations: string[] = [];

  let script: Script;
  try {
    script = parseBash(rawCommand);
  } catch {
    return [rawCommand]; // 解析失败视为全部违规
  }

  const { normalizePath, resolveRealPathRecursive, isForbidden, isWithinWorkspaces } = require("./path-resolver");
  const commands = extractAllCommands(script, rawCommand);
  const expanded = expandWrapperCommands(commands);

  for (const cmd of expanded) {
    const paths = extractFilePaths(cmd);
    for (const rawP of paths) {
      const absPath = normalizePath(rawP, cwd);
      const realPath = resolveRealPathRecursive(absPath);

      if (isForbidden(absPath, config.forbiddenPaths) ||
          isForbidden(realPath, config.forbiddenPaths)) {
        violations.push(`forbidden_path: ${rawP}`);
      }

      if (config.workspaceOnly) {
        if (!isWithinWorkspaces(absPath, config.workspaces) ||
            !isWithinWorkspaces(realPath, config.workspaces)) {
          violations.push(`outside_workspace: ${rawP}`);
        }
      }
    }
  }

  return violations;
}
