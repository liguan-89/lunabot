import { useEffect, useState } from "react";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { openChatLink } from "@/components/ThreadRefs";
import { effectiveCallMode, useCallMode } from "@/lib/call-mode";
import { requestCallStart } from "@/lib/call-start-request";
import { listensHere } from "@/lib/speech";
import { useShowThreads } from "@/lib/thread-preferences";
import { openBot, openThread, type Action, type AppState, type ThreadTarget } from "@/state/store";

export function useExternalChatLinks(state: AppState, dispatch: (action: Action) => void): void {
  const [link, setLink] = useState<string | null>(null);
  const showThreads = useShowThreads();
  useEffect(() => window.ogb?.onChatLink?.(setLink), []);
  useEffect(() => {
    if (!link || !state.hydrated) return;
    setLink(null);
    if (state.appSettingsOpen) dispatch({ type: "toggleAppSettings", open: false });
    if (state.shortcutsOpen) dispatch({ type: "toggleShortcuts", open: false });
    openChatLink(dispatch, link, state, showThreads);
  }, [link, state, showThreads, dispatch]);
}

/** A click on a notification main showed brought this page up, maybe a page just loaded for it. */
export function useDesktopNotificationOpens(state: AppState, dispatch: (action: Action) => void): void {
  const [target, setTarget] = useState<ThreadTarget | null>(null);
  const showThreads = useShowThreads();
  useEffect(() => window.ogb?.desktopNotifications?.onOpen(setTarget), []);
  useEffect(() => {
    if (!target || !state.hydrated) return;
    setTarget(null);
    openThread(dispatch, target, state, showThreads);
  }, [target, state, showThreads, dispatch]);
}

export function useDesktopMountCallStarts(state: AppState, dispatch: (action: Action) => void): void {
  const [botId, setBotId] = useState<string | null>(null);
  const showThreads = useShowThreads();
  const callMode = useCallMode();
  const { capabilities, ready } = useDesktopCapabilities();
  useEffect(() => window.ogb?.desktopMount?.onStartCall?.(setBotId), []);
  useEffect(() => {
    if (!botId || !state.hydrated) return;
    const bot = state.bots.find((candidate) => candidate.id === botId);
    setBotId(null);
    if (!bot) return;
    if (state.appSettingsOpen) dispatch({ type: "toggleAppSettings", open: false });
    if (state.shortcutsOpen) dispatch({ type: "toggleShortcuts", open: false });
    openBot(dispatch, bot, showThreads);
    const turnsHere = !ready || listensHere(capabilities, state.config);
    const mode = effectiveCallMode(callMode, { turnsHere, canLive: true });
    requestCallStart(bot.id, mode);
  }, [botId, state, showThreads, callMode, capabilities, ready, dispatch]);
}
