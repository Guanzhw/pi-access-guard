import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parse as parseBash } from "unbash";
import { extractAllCommands, expandWrapperCommands, getCommandName } from "./bash-parser";
import { getToolRules, resolveBashAction } from "./matching";
import type { Action, Rules, CommandRef } from "./types";
import { buildApprovalPrompt, buildFileApprovalPrompt, buildCustomApprovalPrompt } from "./prompt";

/**
 * Bash 工具的交互式批准。
 * 显示格式化的命令列表（已授权 ✔ / 待批准 ✖）。
 */
export async function handleBashApproval(
  rawCommand: string,
  effectiveRules: Rules,
  ctx: ExtensionContext,
  sessionRules: Record<string, Record<string, string>>,
): Promise<{ block: true; reason: string } | undefined> {
  if (!ctx.hasUI) {
    return { block: true, reason: "[pi-access-guard] No UI for approval" };
  }

  // 解析所有子命令
  let allCommands: CommandRef[];
  try {
    const ast = parseBash(rawCommand);
    allCommands = extractAllCommands(ast, rawCommand);
    allCommands = expandWrapperCommands(allCommands);
  } catch {
    return { block: true, reason: "[pi-access-guard] Bash parse failed" };
  }

  const toolRules = getToolRules(effectiveRules, "bash");

  // 区分已授权和待批准的命令
  const unauthorized: CommandRef[] = [];
  for (const cmd of allCommands) {
    const name = getCommandName(cmd);
    if (!name) continue;

    // 检查 session 规则
    if (sessionRules["bash"]?.[name] === "allow") continue;
    if (sessionRules["bash"]?.["*"] === "allow") continue;

    // 检查规则
    const args = cmd.node.suffix?.map((w: any) => w?.value ?? w?.text ?? "") ?? [];
    let resolved: Action | undefined;

    if (typeof toolRules === "string") {
      resolved = toolRules;
    } else {
      resolved = resolveBashAction(name, args, toolRules as Record<string, Action>);
    }

    if (resolved !== "allow") {
      unauthorized.push(cmd);
    }
  }

  if (unauthorized.length === 0) {
    return undefined; // 全部已授权
  }

  // 构建提示
  const prompt = buildApprovalPrompt(allCommands, unauthorized);

  const choice = await ctx.ui.select(prompt, [
    "Allow",
    "Always allow (session)",
    "Reject",
  ]);

  if (choice === "Reject") {
    return { block: true, reason: "[pi-access-guard] Rejected by user" };
  }

  if (choice === "Always allow (session)") {
    const name = getCommandName(unauthorized[0]);
    if (!sessionRules["bash"]) sessionRules["bash"] = {};
    sessionRules["bash"][name] = "allow";
  }

  // Allow: 放行
  return undefined;
}

/**
 * 文件操作的交互式批准。
 */
export async function handleFileApproval(
  tool: string,
  filePath: string,
  ctx: ExtensionContext,
  sessionRules: Record<string, Record<string, string>>,
): Promise<{ block: true; reason: string } | undefined> {
  if (!ctx.hasUI) {
    return { block: true, reason: "[pi-access-guard] No UI for approval" };
  }

  // 检查 session 规则
  if (sessionRules[tool]?.[filePath] === "allow") return undefined;
  if (sessionRules[tool]?.["*"] === "allow") return undefined;

  const prompt = buildFileApprovalPrompt(tool, filePath);

  const choice = await ctx.ui.select(prompt, [
    "Allow",
    "Always allow (session)",
    "Reject",
  ]);

  if (choice === "Reject") {
    return { block: true, reason: "[pi-access-guard] Rejected by user" };
  }

  if (choice === "Always allow (session)") {
    if (!sessionRules[tool]) sessionRules[tool] = {};
    sessionRules[tool][filePath] = "allow";
  }

  return undefined;
}

/**
 * 自定义工具的交互式批准。
 */
export async function handleCustomApproval(
  tool: string,
  value: string,
  ctx: ExtensionContext,
  sessionRules: Record<string, Record<string, string>>,
): Promise<{ block: true; reason: string } | undefined> {
  if (!ctx.hasUI) {
    return { block: true, reason: "[pi-access-guard] No UI for approval" };
  }

  // 检查 session 规则
  if (sessionRules[tool]?.[value] === "allow") return undefined;
  if (sessionRules[tool]?.["*"] === "allow") return undefined;

  const prompt = buildCustomApprovalPrompt(tool, value);

  const choice = await ctx.ui.select(prompt, [
    "Allow",
    "Always allow (session)",
    "Reject",
  ]);

  if (choice === "Reject") {
    return { block: true, reason: "[pi-access-guard] Rejected by user" };
  }

  if (choice === "Always allow (session)") {
    if (!sessionRules[tool]) sessionRules[tool] = {};
    sessionRules[tool]["*"] = "allow";
  }

  return undefined;
}
