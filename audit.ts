import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AuditConfig, AuditEntry, ExecutionAuditEntry } from "./types";

/**
 * 解析审计文件路径，展开 ~
 */
function resolveAuditPath(configPath: string): string {
  if (configPath.startsWith("~")) {
    const home = os.homedir();
    return path.join(home, configPath.slice(1));
  }
  return path.resolve(configPath);
}

/**
 * 轮转审计文件。
 * 主文件超过 maxSizeMb 后，guard-audit.jsonl → guard-audit.jsonl.1 → .2 → ... → 保留最近 5 个轮转文件。
 */
function rotateIfNeeded(auditPath: string, maxSizeMb: number): void {
  try {
    const stat = fs.statSync(auditPath);
    if (stat.size < maxSizeMb * 1024 * 1024) return;

    // 轮转：删除最旧的文件（.5）
    const lastFile = auditPath + ".5";
    try { fs.unlinkSync(lastFile); } catch { /* 文件不存在 */ }

    // 将 .4 → .5, .3 → .4, ... .1 → .2
    for (let i = 4; i >= 1; i--) {
      const oldFile = auditPath + "." + i;
      const newFile = auditPath + "." + (i + 1);
      try { fs.renameSync(oldFile, newFile); } catch { /* 文件不存在 */ }
    }

    // 将当前文件 → .1
    fs.renameSync(auditPath, auditPath + ".1");
  } catch {
    // 文件不存在或读取失败
  }
}

/**
 * 写入一条裁决审计日志（tool_call 时调用）。
 */
export function writeAuditEntry(
  entry: AuditEntry,
  config: AuditConfig
): void {
  if (!config.enabled) return;
  try {
    const auditPath = resolveAuditPath(config.path);
    const dir = path.dirname(auditPath);

    // 确保目录存在
    fs.mkdirSync(dir, { recursive: true });

    // 轮转检查
    rotateIfNeeded(auditPath, config.maxSizeMb);

    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(auditPath, line, "utf-8");
  } catch {
    // 审计日志写入失败不阻断执行
  }
}

/**
 * 写入一条执行结果审计日志（tool_result 时调用）。
 */
export function writeExecutionAuditEntry(
  entry: ExecutionAuditEntry,
  config: AuditConfig
): void {
  if (!config.enabled) return;
  try {
    const auditPath = resolveAuditPath(config.path);
    const dir = path.dirname(auditPath);
    fs.mkdirSync(dir, { recursive: true });
    rotateIfNeeded(auditPath, config.maxSizeMb);

    const line = JSON.stringify({ ...entry, type: "execution" }) + "\n";
    fs.appendFileSync(auditPath, line, "utf-8");
  } catch {
    // 忽略写入错误
  }
}

/**
 * 读取最近的审计日志。
 */
export function readRecentAudit(
  config: AuditConfig,
  limit: number = 20
): AuditEntry[] {
  const entries: AuditEntry[] = [];
  try {
    const auditPath = resolveAuditPath(config.path);
    const content = fs.readFileSync(auditPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    // 从最后开始读取
    const start = Math.max(0, lines.length - limit);
    for (let i = start; i < lines.length; i++) {
      try {
        entries.push(JSON.parse(lines[i]));
      } catch {
        // 跳过损坏的条目
      }
    }
  } catch {
    // 文件不存在
  }
  return entries;
}

/**
 * 获取审计统计信息。
 */
export function getAuditStats(config: AuditConfig): {
  totalEntries: number;
  fileSizeBytes: number;
  fileSizeMb: string;
  recentBlocks: number;
  recentAllows: number;
} {
  let totalEntries = 0;
  let fileSizeBytes = 0;
  let recentBlocks = 0;
  let recentAllows = 0;

  try {
    const auditPath = resolveAuditPath(config.path);
    const stat = fs.statSync(auditPath);
    fileSizeBytes = stat.size;
    const content = fs.readFileSync(auditPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    totalEntries = lines.length;

    // 分析最近 50 条
    const recent = lines.slice(-50);
    for (const line of recent) {
      try {
        const entry = JSON.parse(line);
        if (entry.action === "deny" || entry.action === "forbidden_path" ||
            entry.action === "outside_workspace" || entry.action === "forbidden_command") {
          recentBlocks++;
        } else if (entry.action === "allow") {
          recentAllows++;
        }
      } catch { /* skip bad line */ }
    }
  } catch {
    // 文件不存在
  }

  return {
    totalEntries,
    fileSizeBytes,
    fileSizeMb: (fileSizeBytes / (1024 * 1024)).toFixed(2),
    recentBlocks,
    recentAllows,
  };
}

/**
 * 清空审计日志。
 */
export function clearAudit(config: AuditConfig): void {
  try {
    const auditPath = resolveAuditPath(config.path);
    fs.writeFileSync(auditPath, "", "utf-8");
  } catch {
    // 忽略错误
  }
}
