/**
 * Uniqueness helpers for things that must not collide.
 *
 * `Date.now()` has millisecond resolution, so two actions in the same tick
 * produce the same value. Use these instead wherever a value is required to
 * be distinct.
 */

let sequence = 0;

/**
 * Strictly increasing counter, unique for the lifetime of this JS context.
 *
 * For in-memory values whose only job is "differ from the previous one" —
 * React re-render nonces, event ordering. Not suitable for filenames: a second
 * window has its own counter starting at zero.
 */
export function nextSequence(): number {
  sequence += 1;
  return sequence;
}

/** Reset the counter. Test-only. */
export function resetSequenceForTests(): void {
  sequence = 0;
}

/**
 * Random token safe for use in a filename.
 *
 * Unlike {@link nextSequence} this is collision-resistant *across processes*,
 * which matters for scratch files written into a shared project folder — two
 * app windows open on the same project would otherwise race.
 */
export function uniqueToken(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") {
    return c.randomUUID().replace(/-/g, "").slice(0, 16);
  }
  if (typeof c?.getRandomValues === "function") {
    const bytes = new Uint8Array(8);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Last resort for a context with no Web Crypto at all. Still combines two
  // independent sources so a same-tick pair cannot collide.
  return `${nextSequence().toString(16)}${Math.random().toString(16).slice(2, 12)}`;
}

/**
 * Prefixed identifier that cannot repeat, for in-memory keys (progress rows,
 * list items). Use {@link scratchSuffix} instead when the value is persisted
 * or becomes a filename.
 */
export function uniqueId(prefix: string): string {
  return `${prefix}-${uniqueToken()}`;
}

/**
 * Filename-safe scratch suffix: a sortable timestamp plus a unique token.
 *
 * The timestamp keeps leftovers identifiable when debugging; the token is what
 * actually guarantees uniqueness.
 */
export function scratchSuffix(now: number = Date.now()): string {
  return `${now}-${uniqueToken()}`;
}
