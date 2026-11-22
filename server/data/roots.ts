import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ExportFolders {
  /** The bot's own workspace, always allowed. */
  workspace: string;
  /** The bot's configured working folder, offered when the caller has no conversation folder of its own. */
  configured?: string;
  /** The conversation's working folder (a pinned project folder, or the conversation's default task workspace);
   *  null means the conversation pinned no folder, so the configured one is not offered either. */
  conversation?: string | null;
  /** Downloads as found on this machine; the caller only sets it to test. */
  downloads?: string | null;
}

/** The folders a data export may write: the conversation's folder when there is one, else the bot's configured
 *  folder, then the bot's workspace and Downloads. */
export function exportFolders(folders: ExportFolders): string[] {
  const downloads = folders.downloads === undefined ? join(homedir(), "Downloads") : folders.downloads;
  return [...new Set([
    ...(downloads && existsSync(downloads) ? [downloads] : []),
    ...(folders.conversation ? [folders.conversation] : []),
    ...(folders.conversation === undefined && folders.configured ? [folders.configured] : []),
    folders.workspace,
  ])];
}

/** The export folders for a bot's turn: the conversation's working folder — a pinned project folder, else the bot's
 *  configured one, else the conversation's default task workspace — with the bot's workspace. */
export function dataExportFolders(bot: { id: string; cwd?: string }, threadId: string | undefined, folders: {
  dataDir: string;
  workspace: (botId: string) => string;
  taskCwd: (botId: string, threadId: string) => string | null | undefined;
}): string[] {
  const pinned = threadId ? folders.taskCwd(bot.id, threadId) : undefined;
  return exportFolders({
    workspace: folders.workspace(bot.id),
    configured: bot.cwd,
    conversation: pinned !== undefined ? pinned
      : threadId ? bot.cwd ?? join(folders.dataDir, "task-workspaces", bot.id, threadId)
      : undefined,
  });
}
