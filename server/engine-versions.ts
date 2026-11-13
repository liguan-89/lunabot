// The engine versions this release was tested with, for the copy the app installs itself.
/** pi follows its vendor's newest release, as its own updater does. */
export const LATEST = "latest";

export interface EngineVersionPin {
  /** The version Install gives and the updater moves to, or LATEST. */
  target: string;
  /** The oldest version this release's driver is known to work with; the target when no older one was checked. A copy
   * below it is retried sooner after a failed update. */
  minimum: string;
  /** The arguments that start the engine's ACP server: a new copy must answer `initialize` there before it replaces one. */
  acp?: readonly string[];
  /** npm packages earlier releases installed this engine as, into the app's npm folder; the app's own build replaces them. */
  formerNpm?: readonly string[];
}

export const ENGINE_VERSIONS: Readonly<Record<string, EngineVersionPin>> = {
  piAgent: { target: "1.5.0", minimum: "1.5.0" },
};

/** The exact npm version Install asks for; undefined follows npm's `latest` tag. */
export function pinnedNpmVersion(driverKind: string): string | undefined {
  const target = ENGINE_VERSIONS[driverKind]?.target;
  return target && target !== LATEST ? target : undefined;
}