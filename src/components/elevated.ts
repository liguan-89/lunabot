export const ELEVATED_CONTROL = "bg-composer ring-1 ring-inset ring-ink/[0.08] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-ink)_5%,transparent)]";
/** A card in the conversation, a question or an approval: the floating surface, resting on the page with a crisp hairline. */
export const ELEVATED_CARD = "bg-composer ring-[0.5px] ring-ink/[0.11] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-ink)_6%,transparent)]";
export const ELEVATED_FLOAT = `${ELEVATED_CARD} shadow-(--shadow-float) backdrop-blur-md`;
/** The hover tint alone, for a control whose aria-expanded is not a menu of its own. */
export const ELEVATED_TINT = "transition-[background-color,box-shadow,border-color,transform] duration-150 hover:bg-[color-mix(in_srgb,var(--color-composer),var(--color-ink)_6%)]";
export const ELEVATED_HOVER = `${ELEVATED_TINT} aria-expanded:bg-[color-mix(in_srgb,var(--color-composer),var(--color-ink)_7%)]`;
/** The hover tint as a plain fill, for a trigger whose aria-expanded sits on a wrapping button. */
export const ELEVATED_OPEN = "bg-[color-mix(in_srgb,var(--color-composer),var(--color-ink)_7%)]";
