// Security: the private folder, inside a bot's own workspace or Local VM workspace, where a secret the person gave for the
// bot's commands lives for a day. Nothing that syncs, backs up, moves, links, attaches, publishes, uploads or snapshots
// workspace files may carry anything under it.
export const SECRET_FOLDER = ".lunabot-secrets";
/** The folder name before the lunabot rename: still refused like the new one, and swept until empty. */
export const LEGACY_SECRET_FOLDER = ".dexbot-secrets";

export const SECRET_FILE_REFUSAL =
  "That file holds a secret the person gave for your own commands only: it cannot be opened from chat, attached, published, uploaded or read by a helper.";

export function inSecretFolder(path: string): boolean {
  const names = path.split(/[\\/]/);
  return names.includes(SECRET_FOLDER) || names.includes(LEGACY_SECRET_FOLDER);
}
