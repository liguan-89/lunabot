// The LUNABOT_* switches the harness gives the agents proxy, read into the profile agents-catalog.ts lists tools for.

/** Which tools a conversation is shown, the same on every one of its turns. Presentation only: the server still
 * authenticates and scopes every call. */
export interface CatalogProfile {
  skillAuthoring: boolean;
  sharedComputers: boolean;
  voiceNotes: boolean;
  /** A treg key or a Cloud plan's research credential is held and this bot's research switch is on: x_search is mounted.
   * Absent means off. */
  xResearch?: boolean;
  /** As xResearch, and research works for that credential (the person's treg key, or a plan whose relay has research
   * on): research_search, research_endpoint and research_call are mounted too. Absent means off. */
  research?: boolean;
  cloudHome: boolean;
  memoryEnabled?: boolean;
  /** The section's Chief of Staff; the server refuses Chief-only tools to every other bot. */
  chief: boolean;
  /** Only for Watcher's own tool. Never written into a schema: a list that names its bot can't share a prompt cache with other bots. */
  botId: string;
  /** A Team Cloud: message_person is mounted. */
  team?: boolean;
  /** The person's Luna Bot with a Chief's powers: its notification tools are mounted. */
  lunabot?: boolean;
  /** A direct chat whose bot may pick where it works (Works on is not Off and no team computer is its own): select_computer
   * is mounted, and the harness refuses a pick on any turn but a person's own message. */
  computerSelection?: boolean;
  /** A room's thread: the wait tools are not mounted, since a room holds no wait. */
  room?: boolean;
  imageGeneration?: boolean;
  videoGeneration?: boolean;
  /** A cloud computer can be had here (Boat): the meeting tools are mounted. */
  meetings?: boolean;
  /** The tool-selection decision job is on: select_tool is mounted. */
  toolSelection?: boolean;
}

/** Everything is off unless the harness says "1". */
export function catalogProfileFromEnv(env: NodeJS.ProcessEnv): CatalogProfile {
  return {
    skillAuthoring: env.LUNABOT_SKILL_AUTHORING_ENABLED === "1",
    sharedComputers: env.LUNABOT_SHARED_COMPUTERS_ENABLED === "1",
    voiceNotes: env.LUNABOT_VOICE_NOTES === "1",
    xResearch: env.LUNABOT_X_RESEARCH === "1",
    research: env.LUNABOT_RESEARCH === "1",
    cloudHome: env.LUNABOT_CLOUD_HOME === "1",
    memoryEnabled: env.LUNABOT_MEMORY_ENABLED !== "0",
    chief: env.LUNABOT_CHIEF_OF_STAFF === "1",
    botId: env.LUNABOT_BOT_ID ?? "",
    team: env.LUNABOT_TEAM_PEOPLE === "1",
    lunabot: env.LUNABOT_LUNABOT === "1",
    computerSelection: env.LUNABOT_COMPUTER_SELECTION === "1",
    room: env.LUNABOT_ROOM === "1",
    imageGeneration: env.LUNABOT_IMAGE_GENERATION === "1",
    videoGeneration: env.LUNABOT_VIDEO_GENERATION === "1",
    meetings: env.LUNABOT_MEETINGS === "1",
    toolSelection: env.LUNABOT_TOOL_SELECTION === "1",
  };
}
