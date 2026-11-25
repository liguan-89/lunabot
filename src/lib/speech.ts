import { keyEntry, savedState } from "@/components/keys/key-catalog";
import type { ConfigStatus } from "@/state/store";
import { desktopCapabilitiesNow } from "./desktop";
import { fishSpeech, type SpeechBridge } from "./fish-speech";

/** Quiet after speech that ends the person's turn in a call, through the Mac's helper or Fish Audio alike: long enough
 * for a short thinking pause mid-sentence. */
export const CALL_ENDPOINT_MS = 1_700;

/** The speech bridge this computer listens through: the page's own Fish Audio listener, or the desktop app's helper. */
export function speechBridge(): SpeechBridge | Window["ogb"] {
  return desktopCapabilitiesNow().dictation.engine === "fish-audio" ? fishSpeech : globalThis.window?.ogb;
}

export function serverListeningReady(config: ConfigStatus | null | undefined): boolean {
  if (savedState(keyEntry("fishAudio"), config).configured) return true;
  const provider = config?.tts?.provider;
  return (provider === "volc" || provider === "qwen") && config?.tts?.configured === true;
}

/** 这里能否听见语音：识别引擎存在；走电脑转写时，还要有任一条服务端可用的识别凭据。 */
export function listensHere(capabilities: DesktopCapabilities, config: ConfigStatus | null | undefined): boolean {
  return capabilities.dictation.available && (capabilities.dictation.engine !== "fish-audio" || serverListeningReady(config));
}
