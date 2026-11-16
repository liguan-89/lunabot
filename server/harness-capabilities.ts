import { APPROVAL_MODES, type ApprovalMode, supportsApprovalMode as driverKindSupportsApprovalMode } from "../shared/approval-mode.ts";
import { availableTools, type CatalogProfile } from "./drivers/agents-catalog.ts";
import type { ModelSelection } from "./contracts.ts";
import { serverLine } from "./server-lines.ts";

export interface DriverCapabilities {
  driverKind: string | undefined;
  agentsMcp: boolean;
}

const ENVELOPE: CatalogProfile = {
  skillAuthoring: true,
  sharedComputers: true,
  voiceNotes: true,
  computerSelection: true,
  cloudHome: false,
  chief: true,
  botId: "",
};

export function harnessCapabilityLines(from: DriverCapabilities | undefined, to: DriverCapabilities | undefined, language?: string): string[] {
  if (!from || !to) return [];
  const lines: string[] = [];
  if (from.agentsMcp !== to.agentsMcp) {
    const names = availableTools(ENVELOPE).map((tool) => tool.name);
    const coordination = ["coordinate_bots", "assignment_status"].filter((name) => names.includes(name));
    lines.push(to.agentsMcp
      ? serverLine(language, "server.modelRequest.gainsTools", { count: names.length, tools: coordination.join(", ") })
      : serverLine(language, "server.modelRequest.losesTools", { count: names.length, tools: coordination.join(", ") }));
  }
  if (from.driverKind !== to.driverKind) {
    const lost = APPROVAL_MODES.filter((mode) => driverKindSupportsApprovalMode(from.driverKind, mode) && !driverKindSupportsApprovalMode(to.driverKind, mode));
    const gained = APPROVAL_MODES.filter((mode) => !driverKindSupportsApprovalMode(from.driverKind, mode) && driverKindSupportsApprovalMode(to.driverKind, mode));
    if (lost.length) lines.push(serverLine(language, "server.modelRequest.losesApproval", { levels: lost.join(", ") }));
    if (gained.length) lines.push(serverLine(language, "server.modelRequest.gainsApproval", { levels: gained.join(", ") }));
  }
  return lines;
}

export type ApprovalModeRegistry = {
  cliTarget(instanceId: string): { driverKind: string } | null;
};

export type ApprovalModeTarget =
  | { driverKind: string | undefined }
  | ModelSelection
  | undefined;

export function createApprovalModeSupport(registry: ApprovalModeRegistry) {
  return function supportsApprovalMode(target: ApprovalModeTarget, mode: ApprovalMode): boolean {
    const driverKind = target === undefined
      ? undefined
      : "driverKind" in target
        ? target.driverKind
        : registry.cliTarget(target.instanceId)?.driverKind;
    return driverKindSupportsApprovalMode(driverKind, mode);
  };
}
