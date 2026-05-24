import type { CommandRef } from "./types";
import { getCommandName } from "./bash-parser";

/**
 * 构建 Bash 命令批准提示。
 * 显示所有命令，已授权 ✔，待批准 ✖。
 */
export function buildApprovalPrompt(
  allCommands: CommandRef[],
  unauthorizedCommands: CommandRef[]
): string {
  const unauthorizedNames = new Set(unauthorizedCommands.map(getCommandName));

  let result = "⚠️ **Unapproved Commands**\n\n";

  result += "```\n";
  for (const cmd of allCommands) {
    const name = getCommandName(cmd);
    const args = cmd.node.suffix?.map((w: any) => w?.value ?? w?.text ?? "") ?? [];
    const fullCmd = [name, ...args].join(" ");
    const marker = unauthorizedNames.has(name) ? "✖" : "✔";
    result += `${marker} ${fullCmd}\n`;
  }
  result += "```\n";

  return result;
}

/**
 * 构建文件操作批准提示。
 */
export function buildFileApprovalPrompt(tool: string, path: string): string {
  return `⚠️ **Unapproved File Operation**\n\nTool: \`${tool}\`\nPath: \`${path}\`\n\nAllow this operation?`;
}

/**
 * 构建自定义工具批准提示。
 */
export function buildCustomApprovalPrompt(tool: string, input: string): string {
  const truncated = input.length > 200 ? input.substring(0, 200) + "..." : input;
  return `⚠️ **Unapproved Tool Call**\n\nTool: \`${tool}\`\nInput: \`${truncated}\`\n\nAllow this operation?`;
}
