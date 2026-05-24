import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadConfig, loadProjectConfig, buildEffectiveRules } from "./config";
import { getPresetRules } from "./defaults";
import { evaluatePolicy } from "./policy";
import { writeAuditEntry, writeExecutionAuditEntry } from "./audit";
import { handleBashApproval, handleFileApproval, handleCustomApproval } from "./handlers";
import { registerCommands, type CommandContext } from "./commands";
import type { Action, GuardConfig, Rules } from "./types";
export { loadConfig, loadProjectConfig };

export default function (pi: ExtensionAPI) {
  // ============================================================
  // 配置加载
  // ============================================================
  const loaded = loadConfig();
  const projectResult = loadProjectConfig(process.cwd());

  // 默认系统工作区：pi 自身安装路径和用户数据目录
  // 这些路径对 pi 的正常运行是必需的（读取自身文档、扩展、记忆等）
  function getSystemWorkspaces(): string[] {
    const sysPaths: string[] = [];
    // pi 用户数据目录（扩展、技能、记忆、配置）
    sysPaths.push(path.join(os.homedir(), ".pi"));
    // 检测 pi 安装路径：尝试多个策略
    const piPkgName = "@earendil-works/pi-coding-agent";
    function addPiPaths(pkgDir: string) {
      if (!fs.existsSync(path.join(pkgDir, "package.json"))) return false;
      sysPaths.push(pkgDir);
      // node_modules 层级（docs/ 等可能引用包外资源）
      const nmDir = path.dirname(pkgDir); // @earendil-works
      const nmParent = path.dirname(nmDir); // node_modules
      sysPaths.push(nmParent);
      return true;
    }
    // 策略 1：require.resolve（当扩展在 pi 上下文中加载时有效）
    try {
      if (addPiPaths(path.dirname(require.resolve(piPkgName + "/package.json")))) {
        return sysPaths;
      }
    } catch { /* fall through */ }
    try {
      if (addPiPaths(path.dirname(require.resolve(piPkgName)))) {
        return sysPaths;
      }
    } catch { /* fall through */ }
    // 策略 1.5：通过 which pi 找到二进制 → 解析符号链接 → 定位包根目录
    // 比 npm root -g 更快（无需启动 npm），直接定位到实际运行的 pi 安装
    try {
      const whichResult = execSync("which pi", {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (whichResult) {
        // 解析符号链接链得到真实路径（如 dist/cli.js）
        const realBin = fs.realpathSync(whichResult);
        // 从真实路径向上查找包含 package.json 的目录
        let pkgDir = path.dirname(realBin);
        const root = path.parse(pkgDir).root;
        while (pkgDir !== root) {
          if (fs.existsSync(path.join(pkgDir, "package.json"))) {
            if (addPiPaths(pkgDir)) return sysPaths;
            break;
          }
          pkgDir = path.dirname(pkgDir);
        }
      }
    } catch { /* fall through */ }

    // 策略 1.6：使用 npm root -g 查找全局 node_modules（比 which pi 更通用）
    try {
      const npmRoot = execSync("npm root -g", {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (npmRoot) {
        const candidate = path.join(npmRoot, ...piPkgName.split("/"));
        if (addPiPaths(candidate)) return sysPaths;
      }
    } catch { /* fall through */ }

    // 策略 2：从 Node 二进制路径推导 global prefix
    // process.execPath 如 /usr/local/bin/node → prefix = /usr/local
    try {
      const execPath = process.execPath.replace(/\\/g, "/");
      const binIndex = execPath.lastIndexOf("/bin/");
      if (binIndex > 0) {
        const prefix = execPath.slice(0, binIndex);
        const candidate = path.join(prefix, "lib", "node_modules", ...piPkgName.split("/"));
        if (addPiPaths(candidate)) return sysPaths;
      }
    } catch { /* fall through */ }
    // 策略 3：检查 NODE_PATH 环境变量
    try {
      if (process.env.NODE_PATH) {
        for (const p of process.env.NODE_PATH.split(path.delimiter)) {
          const candidate = path.join(p, ...piPkgName.split("/"));
          if (addPiPaths(candidate)) return sysPaths;
        }
      }
    } catch { /* fall through */ }
    // 策略 4：常见全局安装路径
    const commonPaths = process.platform === "win32"
      ? [path.join(process.env.APPDATA || "", "npm/node_modules")]
      : [
          "/usr/local/lib/node_modules",
          "/usr/lib/node_modules",
          path.join(os.homedir(), ".npm-global/lib/node_modules"),
        ];
    for (const base of commonPaths) {
      const candidate = path.join(base, ...piPkgName.split("/"));
      if (addPiPaths(candidate)) return sysPaths;
    }
    return sysPaths;
  }

  // 合并用户配置的工作区 + 系统默认工作区
  const userWorkspaces = (projectResult?.config.workspaces ?? loaded.config.workspaces)
    .map(w => path.resolve(w === "." ? process.cwd() : w));
  const systemWorkspaces = getSystemWorkspaces();
  const resolvedWorkspaces = [...new Set([...userWorkspaces, ...systemWorkspaces])];

  // 系统规则：对 pi 自身路径自动放行读/写/编辑，常用维护命令自动放行
  function buildSystemRules(workspaces: string[]): Rules {
    const writeRules: Record<string, Action> = {};
    const editRules: Record<string, Action> = {};
    for (const ws of workspaces) {
      const pattern = ws.endsWith("/") ? ws + "**" : ws + "/**";
      writeRules[pattern] = "allow";
      editRules[pattern] = "allow";
    }
    const readRules: Record<string, Action> = {};
    for (const ws of workspaces) {
      const pattern = ws.endsWith("/") ? ws + "**" : ws + "/**";
      readRules[pattern] = "allow";
    }
    return {
      read: readRules,
      write: writeRules,
      edit: editRules,
      bash: {
        "npm install": "allow", "npm uninstall": "allow",
        "npm update": "allow", "npm config": "allow",
        "npx": "allow",
        "pi": "allow",
        "mkdir": "allow", "cp": "allow", "mv": "allow",
        "chmod": "allow", "chown": "allow",
        "ln": "allow", "cat": "allow", "echo": "allow",
      },
    } as Rules;
  }
  const systemRules = buildSystemRules(systemWorkspaces);

  const config: GuardConfig = {
    ...loaded.config,
    ...(projectResult?.config ?? {}),
    workspaces: resolvedWorkspaces,
  };

  for (const w of loaded.warnings) {
    console.warn(`[pi-access-guard] ${w}`);
  }
  if (projectResult?.warnings) {
    for (const w of projectResult.warnings) {
      console.warn(`[pi-access-guard] ${w}`);
    }
  }

  console.warn(`[pi-access-guard] loaded (preset=${config.preset}, workspaces=${JSON.stringify(config.workspaces)})`);

  // ============================================================
  // 运行时状态
  // ============================================================
  let activeProfile: string | undefined;
  const sessionRules: Record<string, Record<string, string>> = {};

  // ============================================================
  // 注册管理命令
  // ============================================================
  const cmdCtx: CommandContext = {
    getConfig: () => config,
    setConfig: (c) => Object.assign(config, c),
    getActiveProfile: () => activeProfile,
    setActiveProfile: (p) => { activeProfile = p; },
    getSessionRules: () => sessionRules,
  };
  registerCommands(pi, cmdCtx);

  // ============================================================
  // 核心拦截钩子：tool_call
  // ============================================================
  pi.on("tool_call", async (event, ctx) => {
    if (ctx.signal?.aborted) return;
    if (!config.enabled) return;

    const toolName = event.toolName;
    const input = event.input as Record<string, unknown>;
    const cwd = ctx.cwd ?? process.cwd();

    const presetRules = getPresetRules(config.preset);
    const profileRules = activeProfile
      ? (config.profiles?.[activeProfile] ?? undefined) : undefined;
    const effectiveRules = buildEffectiveRules(
      config.preset,
      presetRules,
      systemRules,                       // 系统规则（pi 自身路径自动放行）
      loaded.userRules ?? {},            // 纯用户规则（从 ~/.pi/agent/settings.json）
      projectResult?.config?.rules as Rules | undefined ?? {},  // 纯项目规则
      loaded.envRules,                   // PI_GUARD 环境变量规则
      profileRules,
      sessionRules,
    );

    // === 使用策略引擎做完整裁决 ===
    const result = await evaluatePolicy({
      toolName,
      input,
      cwd,
      config,
      effectiveRules,
    });

    // === 审计日志 ===
    if (config.audit.enabled) {
      writeAuditEntry({
        ts: new Date().toISOString(),
        tool: toolName,
        action: deriveAuditAction(result),
        reason: result.reason,
        path: (input as any).path,
        command: config.audit.includeInputs ? (input as any)._originalCommand ?? (input as any).command : undefined,
        cwd,
      }, config.audit);
    }

    // === 裁决 ===
    if (result.action === "deny") {
      return { block: true, reason: `[pi-access-guard] ${result.reason}` };
    }

    if (result.action === "ask") {
      if (!ctx.hasUI) {
        return { block: true, reason: "[pi-access-guard] No UI for approval" };
      }

      if (isToolCallEventType("bash", event)) {
        // event.input.command 已被 evaluatePolicy 包裹为 env -i bash << ...
        // 使用 _originalCommand 获取原始命令用于批准提示
        const originalCmd = (input as any)._originalCommand ?? event.input.command;
        const block = await handleBashApproval(
          originalCmd, effectiveRules, ctx, sessionRules
        );
        if (block) return block;
      } else if (isToolCallEventType("read", event) ||
                 isToolCallEventType("write", event) ||
                 isToolCallEventType("edit", event)) {
        const block = await handleFileApproval(
          toolName, event.input.path, ctx, sessionRules
        );
        if (block) return block;
      } else {
        // 其他工具 — 提取第一个非空输入值用于批准
        const firstKey = Object.keys(input).find(k => k !== "cwd" && typeof input[k] === "string");
        const value = firstKey ? String(input[firstKey]) : toolName;
        const block = await handleCustomApproval(
          toolName, value, ctx, sessionRules
        );
        if (block) return block;
      }
    }

    // allow: 放行（mutatedInput 已经修改了 event.input）
    return;
  });
  // ============================================================
  // 执行结果审计钩子：tool_result
  // ============================================================
  pi.on("tool_result", (event) => {
    if (!config.audit.enabled) return;
    writeExecutionAuditEntry({
      ts: new Date().toISOString(),
      tool: event.toolName,
      success: !event.isError,
      toolCallId: event.toolCallId,
    }, config.audit);
  });
}

/**
 * 从裁决结果中提取审计动作类型。
 */
function deriveAuditAction(
  result: { action: string; reason: string }
): import("./types").AuditEntry["action"] {
  if (result.reason.startsWith("forbidden_path")) return "forbidden_path";
  if (result.reason.startsWith("outside_workspace")) return "outside_workspace";
  if (result.reason.startsWith("forbidden_command")) return "forbidden_command";
  if (result.reason.startsWith("not_in_whitelist")) return "forbidden_command";
  if (result.reason.startsWith("bash_rule")) return "forbidden_command";
  if (result.reason.startsWith("bash_forbidden_path")) return "forbidden_path";
  if (result.reason.startsWith("bash_outside_workspace")) return "outside_workspace";
  return result.action as import("./types").Action;
}
