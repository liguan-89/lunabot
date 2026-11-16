export const MAX_COMPAT_BASE_URL_LENGTH = 2048;

export type CompatBaseUrlProblem = "too-long" | "invalid-url" | "unsafe-url";

export function compatBaseUrlProblem(raw: string): CompatBaseUrlProblem | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.length > MAX_COMPAT_BASE_URL_LENGTH) return "too-long";

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid-url";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid-url";
  if (url.username || url.password || url.search || url.hash) return "unsafe-url";
  return null;
}
