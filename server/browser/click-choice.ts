// The narrow seam between the browser's click tool and a decision model. The browser only offers candidates and
// receives a ref back; it never imports the decider, and a missing or failed choice leaves the existing click path.
export interface ClickCandidate {
  ref: string;
  role?: string;
  name?: string;
}

export interface ClickChoiceInput {
  /** The bot's words for what to click, when it passed an intent instead of a ref. */
  intent?: string;
  /** The selector that matched several elements, when that is why the model is asked. */
  selector?: string;
  candidates: ClickCandidate[];
  url?: string;
  title?: string;
}

export interface ClickChoice {
  /** Cheap check before a snapshot or a model call: the job is on and a decision model is ready. */
  enabled(): boolean;
  choose(session: string, input: ClickChoiceInput): Promise<{ ref: string; pTop: number } | null>;
}
