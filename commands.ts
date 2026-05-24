import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GuardConfig, PresetName } from "./types";
import { readRecentAudit, getAuditStats, clearAudit } from "./audit";

export interface CommandContext {
  getConfig: () => GuardConfig;
  setConfig: (c: Partial<GuardConfig>) => void;
  getActiveProfile: () => string | undefined;
  setActiveProfile: (p: string | undefined) => void;
  getSessionRules: () => Record<string, Record<string, string>>;
}

/**
 * 注册 /guard 命令族。
 */
export function registerCommands(
  pi: ExtensionAPI,
  cmdCtx: CommandContext
): void {
  pi.registerCommand("guard", {
    description: "Manage pi-access-guard security settings",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/);
      const command = parts[0]?.toLowerCase() ?? "";
      const subArgs = parts.slice(1);

      switch (command) {
        case "status":
          return handleStatus(cmdCtx, ctx);
        case "enable":
          return handleEnable(cmdCtx, ctx);
        case "disable":
          return handleDisable(cmdCtx, ctx);
        case "preset":
          return handlePreset(cmdCtx, subArgs, ctx);
        case "audit":
          return handleAudit(cmdCtx, subArgs, ctx);
        case "profile":
          return handleProfile(cmdCtx, subArgs, ctx);
        case "session":
          return handleSession(cmdCtx, subArgs, ctx);
        case "version":
          ctx.ui.notify("pi-access-guard v0.1.0", "info");
          break;
        default:
          ctx.ui.notify("Available: status, enable, disable, preset <name>, audit, profile <name|off>, session allow <tool> <pattern>", "info");
      }
    },
  });
}

// ============ 命令处理函数 ============

function handleStatus(cmdCtx: CommandContext, ctx: ExtensionCommandContext): void {
  const config = cmdCtx.getConfig();
  const stats = getAuditStats(config.audit);
  const profile = cmdCtx.getActiveProfile();

  const lines = [
    `pi-access-guard status`,
    `  Enabled:      ${config.enabled ? "✅ yes" : "❌ no"}`,
    `  Preset:       ${config.preset}`,
    `  Profile:      ${profile ?? "(none)"}`,
    `  Workspaces:   ${config.workspaces.join(", ")}`,
    `  Workspace-only: ${config.workspaceOnly ? "yes" : "no"}`,
    `  Forbidden paths: ${config.forbiddenPaths.length} patterns`,
    `  Allowed commands: ${config.allowedCommands.length > 0 ? config.allowedCommands.join(", ") : "(all, using preset)"}`,
    `  Audit:        ${config.audit.enabled ? `enabled (${stats.totalEntries} entries, ${stats.fileSizeMb} MB)` : "disabled"}`,
    `  Recent 50:    ${stats.recentBlocks} blocked, ${stats.recentAllows} allowed`,
  ];

  ctx.ui.notify(lines.join("\n"), "info");
}

function handleEnable(cmdCtx: CommandContext, ctx: ExtensionCommandContext): void {
  const config = cmdCtx.getConfig();
  config.enabled = true;
  ctx.ui.notify("pi-access-guard enabled", "info");
}

function handleDisable(cmdCtx: CommandContext, ctx: ExtensionCommandContext): void {
  const config = cmdCtx.getConfig();
  config.enabled = false;
  ctx.ui.notify("pi-access-guard disabled", "warning");
}

function handlePreset(cmdCtx: CommandContext, args: string[], ctx: ExtensionCommandContext): void {
  if (args.length === 0) {
    ctx.ui.notify(`Current preset: ${cmdCtx.getConfig().preset}`, "info");
    return;
  }

  const name = args[0] as PresetName;
  if (!["isolated", "standard", "trusted"].includes(name)) {
    ctx.ui.notify(`Invalid preset: ${name}. Choose: isolated, standard, trusted`, "error");
    return;
  }

  const config = cmdCtx.getConfig();
  config.preset = name;
  ctx.ui.notify(`Switched to preset: ${name}`, "info");
}

function handleAudit(cmdCtx: CommandContext, args: string[], ctx: ExtensionCommandContext): void {
  const config = cmdCtx.getConfig();

  if (args[0] === "clear") {
    clearAudit(config.audit);
    ctx.ui.notify("Audit log cleared", "info");
    return;
  }

  const entries = readRecentAudit(config.audit, 20);
  if (entries.length === 0) {
    ctx.ui.notify("No audit entries", "info");
    return;
  }

  const lines = entries.map((e, i) => {
    const actionIcon = e.action === "allow" ? "✅" : e.action === "deny"
      ? "❌" : e.action === "ask" ? "⚠️" : "🚫";
    const pathStr = e.path ? ` ${e.path}` : "";
    const cmdStr = e.command ? ` cmd:${e.command.slice(0, 60)}` : "";
    return `${actionIcon} [${e.ts.slice(0, 19)}] ${e.tool}: ${e.reason}${pathStr}${cmdStr}`;
  });

  ctx.ui.notify(`Recent audit (${entries.length} entries):\n` + lines.join("\n"), "info");
}

function handleProfile(cmdCtx: CommandContext, args: string[], ctx: ExtensionCommandContext): void {
  if (args.length === 0) {
    const profile = cmdCtx.getActiveProfile();
    ctx.ui.notify(`Active profile: ${profile ?? "(none)"}`, "info");
    return;
  }

  if (args[0] === "off") {
    cmdCtx.setActiveProfile(undefined);
    ctx.ui.notify("Profile deactivated", "info");
    return;
  }

  const config = cmdCtx.getConfig();
  const profile = args[0];
  if (!config.profiles?.[profile]) {
    ctx.ui.notify(`Profile "${profile}" not found in config`, "error");
    return;
  }

  cmdCtx.setActiveProfile(profile);
  ctx.ui.notify(`Profile "${profile}" activated`, "info");
}

function handleSession(cmdCtx: CommandContext, args: string[], ctx: ExtensionCommandContext): void {
  if (args.length < 3) {
    ctx.ui.notify("Usage: /guard session allow <tool> <pattern>", "info");
    return;
  }

  const action = args[0]?.toLowerCase();
  if (action !== "allow") {
    ctx.ui.notify("Only 'allow' is supported for session rules", "error");
    return;
  }

  const tool = args[1];
  const pattern = args.slice(2).join(" ");

  if (!tool || !pattern) {
    ctx.ui.notify("Usage: /guard session allow <tool> <pattern>", "info");
    return;
  }

  const sessionRules = cmdCtx.getSessionRules();
  if (!sessionRules[tool]) sessionRules[tool] = {};
  sessionRules[tool][pattern] = "allow";

  ctx.ui.notify(`Session rule added: ${tool} ${pattern} → allow`, "info");
}
