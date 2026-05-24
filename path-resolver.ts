import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { minimatch } from "minimatch";
import type { GuardConfig, Matcher, Matchers } from "./types";

/**
 * 获取用户 home 目录，跨平台安全。
 * 使用 os.homedir() 而非 process.env，避免 Windows+Git Bash 下
 * HOME 环境变量返回 Unix 风格路径（如 /c/Users/name）导致路径错误。
 */
function getHomeDir(): string {
  return os.homedir();
}

/**
 * 展开路径中的 ~ 为用户 home 目录。
 */
function expandTilde(p: string): string {
  if (p.startsWith("~")) {
    return p.replace(/^~/, getHomeDir());
  }
  return p;
}

/**
 * 标准化路径比较：Windows 上忽略大小写。
 */
function normalizeForCompare(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * 将输入路径标准化为绝对路径。
 * 处理：相对路径 → CWD 绝对化、~ → HOME 展开
 */
export function normalizePath(inputPath: string, cwd: string): string {
  let p = expandTilde(inputPath);

  // 相对路径 → 绝对路径
  if (!path.isAbsolute(p)) {
    p = path.resolve(cwd, p);
  }

  return path.normalize(p);
}

/**
 * 递归解析符号链接直到稳定，最大 20 跳。
 *
 * 单次 realpathSync 不够——链接链 > 1 跳即可绕过检查
 * （如 workspace/link1 → workspace/ok/link2 → /etc）。
 *
 * 对不存在的路径（ENOENT）：逐段向上查找父目录中的符号链接，
 * 重组真实路径后再检查。
 */
export function resolveRealPathRecursive(absPath: string, maxHops = 20): string {
  let current = absPath;

  for (let i = 0; i < maxHops; i++) {
    try {
      const resolved = fs.realpathSync(current);
      if (resolved === current) break; // 稳定
      current = resolved;
    } catch (e: unknown) {
      const err = e as Error & { code?: string };
      if (err.code === "ENOENT") {
        // 路径尚不存在（如 write 新文件）：逐段解析父目录
        let parent = path.dirname(current);
        let found = false;
        while (parent !== current) {
          try {
            const realParent = fs.realpathSync(parent);
            if (realParent !== parent) {
              current = path.join(realParent, path.relative(parent, current));
              found = true;
              break; // 重新进入外层循环
            }
          } catch {
            // parent 也不存在，继续向上
          }
          const next = path.dirname(parent);
          if (next === parent) break;
          parent = next;
        }
        if (!found) break; // 无法解析，使用当前值
      } else {
        break; // 其他错误，使用当前值
      }
    }
  }

  return current;
}

/**
 * 判断路径是否在工作区白名单内。
 * 使用路径前缀匹配（路径必须以 workspace 为前缀）。
 * 同时支持 / 和 \ 分隔符（Windows/WSL 兼容）。
 */
export function isWithinWorkspaces(
  absPath: string,
  workspaces: string[]
): boolean {
  if (workspaces.length === 0) return false;

  const normalizedPath = normalizeForCompare(absPath);
  const pathWithSep = normalizedPath.endsWith("/")
    ? normalizedPath : normalizedPath + "/";

  return workspaces.some(ws => {
    const normalizedWs = normalizeForCompare(ws);
    const wsWithSep = normalizedWs.endsWith("/")
      ? normalizedWs : normalizedWs + "/";
    return pathWithSep.startsWith(wsWithSep);
  });
}

/**
 * 判断路径是否匹配 forbidden 列表。
 * 使用前缀匹配 + glob 双重检查：
 *   - 前缀匹配：路径前缀匹配 forbidden 中的前缀模式（去掉 ** 后缀）
 *   - glob 匹配：使用 minimatch 做完整 glob 匹配
 * 任一种命中 → true。
 * 双重检查确保 "/home/user/.ssh/id_rsa" 被 "~/.ssh/**" 拦截。
 */
export function isForbidden(absPath: string, forbiddenPaths: string[]): boolean {
  const normalizedPath = normalizeForCompare(absPath);

  for (const pattern of forbiddenPaths) {
    // 展开 ~
    let p = expandTilde(pattern);
    p = p.replace(/\\/g, "/");
    const compareP = normalizeForCompare(p);

    // 前缀匹配：去掉尾部 **（如果有），检查是否以前缀开头
    const prefix = compareP.replace(/\*\*\/?$/, "").replace(/\/$/, "");
    if (prefix && normalizedPath.startsWith(prefix + "/")) {
      return true;
    }

    // glob 匹配（dot: true 确保 .env 之类以点开头的文件也被匹配）
    // Windows 上启用 nocase 以正确匹配大小写不敏感路径
    const globOpts = process.platform === "win32" ? { dot: true, nocase: true } : { dot: true };
    if (minimatch(absPath.replace(/\\/g, "/"), p, globOpts)) {
      return true;
    }
  }

  return false;
}

/**
 * 从工具输入中提取主路径参数。
 */
export function extractPrimaryPath(
  input: Record<string, unknown>,
  matcher?: Matcher
): string | undefined {
  if (!matcher) return undefined;
  const val = input[matcher.param];
  if (typeof val === "string") return val;
  return undefined;
}

/**
 * 从工具输入中提取所有路径参数。
 * - read/write/edit: event.input.path
 * - bash: 需要 bash-parser 提取（返回空，由 bash-parser 处理）
 * - 其他: 根据 matchers 配置
 */
export function extractPaths(
  toolName: string,
  input: Record<string, unknown>,
  matchers: Matchers
): string[] {
  const matcher = matchers[toolName];
  if (!matcher) return [];

  if (matcher.type === "bash") {
    // bash 工具的路径提取由 bash-parser 处理
    return [];
  }

  const paths: string[] = [];
  if (matcher.type === "glob" || matcher.type === "exact") {
    const val = extractPrimaryPath(input, matcher);
    if (val) paths.push(val);
  }

  return paths;
}

/**
 * 路径安全综合检查 → 返回阻止原因或 undefined（通过）。
 */
export function checkPathSafety(
  toolName: string,
  input: Record<string, unknown>,
  config: GuardConfig,
  cwd: string
): { block: true; reason: string } | undefined {
  const paths = extractPaths(toolName, input, config.matchers);

  for (const rawPath of paths) {
    const absPath = normalizePath(rawPath, cwd);
    const realPath = resolveRealPathRecursive(absPath);

    // forbidden 检查（原路径和真实路径都要检查）
    if (isForbidden(absPath, config.forbiddenPaths) ||
        isForbidden(realPath, config.forbiddenPaths)) {
      return { block: true, reason: `forbidden_path: ${rawPath}` };
    }

    // workspace 检查：符号链接解析后的真实路径必须在工作区内
    // （防止 symlink-in-workspace → outside 的绕过）
    if (config.workspaceOnly) {
      // 先检查原路径是否在工作区内（快速路径：不在则直接 block）
      // 再检查真实路径是否在工作区内（防止符号链接绕过）
      if (!isWithinWorkspaces(absPath, config.workspaces) ||
          !isWithinWorkspaces(realPath, config.workspaces)) {
        return { block: true, reason: `outside_workspace: ${rawPath}` };
      }
    }
  }

  return undefined;
}
