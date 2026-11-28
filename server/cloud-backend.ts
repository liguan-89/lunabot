export const CLOUD_BACKEND_CHANGE_ERROR = "stop the active turn before changing the cloud backend";
export const VPS_ALIAS_RESOURCES_ERROR =
  "remove this installation's VPS computers before changing or clearing the SSH config alias";

export const VPS_BOT_ALIAS_RESOURCES_ERROR =
  "remove this bot's VPS computer before changing its SSH config alias (Settings → Local VM → Self-hosted VPS computers)";
export const VPS_BOT_ALIAS_CHANGE_ERROR = "stop the active turn before changing this bot's VPS SSH alias";
export const VPS_BOT_ALIAS_LIFECYCLE_ERROR = "wait for VPS computer actions to finish before changing this bot's SSH alias";

/** A server that cannot answer never keeps a bot on it or keeps it alive: what may be left there, and how to remove it. */
export function vpsLeftBehindNotice(done: "Moved" | "Deleted", alias: string, containerName: string): string {
  return `${done}. ${alias} could not be reached, so this bot's computer there, if it is still there, was left as it is. ` +
    `When ${alias} is back, remove it with: docker -H ssh://${alias} rm -f ${containerName}`;
}

/** What an unreachable old default alias may still run for this installation, and how to find and remove it. */
export function vpsAliasLeftBehindNotice(done: "Saved" | "Removed", alias: string, environmentFilter: string | null, managedFilter: string): string {
  return `${done}. ${alias} could not be reached, so this installation's computers there, if any are still there, were left as they are. ` +
    (environmentFilter
      ? `When ${alias} is back, list them with: docker -H ssh://${alias} ps -a --filter ${environmentFilter} ` +
        `and remove any you no longer need with: docker -H ssh://${alias} rm -f <name>. `
      : `This installation's ID could not be read, so no filter lists only its computers on ${alias}. `) +
    `Computers made by older versions have no installation label: docker -H ssh://${alias} ps -a --filter ${managedFilter} lists every managed one, ` +
    `so remove one of those only when you have its exact name from this installation, such as the one in a bot's move or delete notice. ` +
    `A name that only starts with lunabot-vps- does not prove it is this installation's: if you have nothing more, leave it.`;
}

export function cloudBackendChangeError(botBusy: boolean, activeVpsThread: boolean): string | null {
  return botBusy || activeVpsThread ? CLOUD_BACKEND_CHANGE_ERROR : null;
}

export function vpsBotAliasChangeError(botBusy: boolean, activeVpsThread: boolean): string | null {
  return botBusy || activeVpsThread ? VPS_BOT_ALIAS_CHANGE_ERROR : null;
}

export function vpsAliasResourceChangeError(instanceCount: number): string | null {
  return instanceCount > 0 ? VPS_ALIAS_RESOURCES_ERROR : null;
}
