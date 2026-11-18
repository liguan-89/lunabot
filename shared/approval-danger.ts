export interface DangerApprovalInput {
  tool?: string;
  commandLine?: string;
  approvalScope?: string;
  opaque?: boolean;
  always?: boolean;
}

const DESTRUCTIVE_TOOLS = new Set(["fill_payment", "delete"]);
const LOCAL_DESTRUCTIVE_TOOL = /(?:^|[_:])(delete|remove|erase|format|wipe|destroy)(?:$|[_:])/i;

const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  // Recursive delete targeting root, home, or top-level system directories (never relative subpaths like ./build).
  /(?:^|[;&|]\s*)(?:sudo\s+)?rm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b[^;&|\n]*\s+(?:\/(?:\s|$|\*)|~(?:\/\*?)?(?:\s|$)|\$HOME(?:\/\*?)?(?:\s|$)|\/(?:etc|usr|bin|sbin|var|boot|home|lib(?:32|64|x32)?|System|Library|Applications|Users)(?:\/\*?)?(?:\s|$)|[A-Za-z]:\\(?:\*|\s|$))/i,
  // Disk formatting or raw device overwrite.
  /(?:^|[;&|]\s*)(?:sudo\s+)?(?:mkfs(?:\.[a-z0-9]+)?\s+|dd\s+[^;&|\n]*of=\/dev\/(?:r?disk|sd|hd|vd|nvme|mmcblk)|diskutil\s+(?:apfs\s+)?(?:eraseDisk|eraseVolume|reformat)\b|format\s+[A-Za-z]:)/i,
  // Destructive git history / working-tree operations.
  /(?:^|[;&|]\s*)git\s+(?:push\b[^;&|\n]*(?:\s--force\b|\s-f\b)|reset\s+--hard\b|clean\s+-[a-zA-Z]*f[a-zA-Z]*)/i,
  // Destructive SQL statements.
  /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i,
  // Privilege escalation.
  /(?:^|[;&|]\s*)sudo\s+/i,
];

export function isDangerousApprovalRequest(input: DangerApprovalInput): boolean {
  if (input.always === true || input.opaque === true) return true;
  if (input.tool && DESTRUCTIVE_TOOLS.has(input.tool)) return true;
  if (input.approvalScope === "local-computer" && input.tool && LOCAL_DESTRUCTIVE_TOOL.test(input.tool)) return true;
  if (input.commandLine) {
    return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(input.commandLine!));
  }
  return false;
}
