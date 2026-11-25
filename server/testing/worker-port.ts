// CI runs test files side by side on vitest's workers, and a suite's ports are only probed, never reserved. So a port's
// low bits name the worker that may use it: two workers never pick the same port, whatever range each asks for. Two
// slots each, because a harness also listens one above its own port. Outside a worker a port stays as it was picked.
import { readFileSync } from "node:fs";

const SLOTS = 32;

export function forWorker(port: number, poolId: string | undefined = process.env.VITEST_POOL_ID): number {
  const id = Number(poolId);
  if (!Number.isSafeInteger(id) || id < 1) return port;
  return port - (port % SLOTS) + ((id - 1) % (SLOTS / 2)) * 2;
}

let floor: number | undefined;

/** The lowest port the OS hands out itself: Linux's ip_local_port_range, else IANA's dynamic range (macOS, Windows). */
export function ephemeralFloor(): number {
  if (floor === undefined) {
    try {
      floor = Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]) || 49_152;
    } catch {
      floor = 49_152;
    }
  }
  return floor;
}

/** A random port of this worker in `from`..`from + span`, for a suite that has no time to probe. Ranges are clamped
 * below the ephemeral range — a pick inside it loses to whatever outbound connection the runner opened in between. */
export function workerPort(from: number, span: number): number {
  const usable = Math.min(span, ephemeralFloor() - from);
  if (usable <= 0) throw new Error(`workerPort range ${from}..${from + span} sits inside the ephemeral range (floor ${ephemeralFloor()})`);
  return forWorker(from + Math.floor(Math.random() * usable));
}
