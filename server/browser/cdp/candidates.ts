// The interactive refs a rendered accessibility snapshot already offers, parsed back into candidates for a click
// choice. This reads the tree text only: it never evaluates page code or builds a command.
export interface SnapshotCandidate {
  ref: string;
  role?: string;
  name?: string;
}

const CANDIDATE_LINE = /^\s*-\s+([a-zA-Z][\w-]*)(?:\s+("(?:[^"\\]|\\.)*"))?/;
const REF = /\[ref=(e\d+)\]/;

/** Interactive refs from a rendered snapshot tree, with the role and accessible name shown beside them. */
export function snapshotCandidates(tree: string): SnapshotCandidate[] {
  const out: SnapshotCandidate[] = [];
  for (const line of tree.split("\n")) {
    const ref = line.match(REF)?.[1];
    if (!ref || line.includes("[disabled]")) continue;
    const match = line.match(CANDIDATE_LINE);
    const role = match?.[1];
    let name: string | undefined;
    if (match?.[2]) {
      try {
        name = JSON.parse(match[2]) as string;
      } catch {
        name = match[2].slice(1, -1);
      }
    }
    out.push({ ref, ...(role ? { role } : {}), ...(name ? { name } : {}) });
  }
  return out;
}
