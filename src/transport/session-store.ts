import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  /** Mutable Bearer; updated on every request to handle OAuth refresh mid-session. */
  token: string;
  /**
   * Stable identity of the principal that created this session (OAuth `sub` or
   * a PAT hash). A request whose bearer resolves to a different subject is NEVER
   * bound to this transport: that would be session hijack (any valid bearer +
   * a guessed live session id) and would let a concurrent dispatch read another
   * principal's swapped-in token. Cross-subject reuse is served statelessly.
   */
  subject: string;
  /** Epoch ms of the last request on this session; drives idle eviction. */
  lastSeen: number;
  /**
   * Count of requests currently being handled on this session's transport.
   * `lastSeen` is stamped at request START, so a session running a 60-120s heavy
   * tool (search_papers_many / verify_claims / extract_from_papers /
   * gather_evidence) looks like the stalest entry and would be the LRU eviction
   * victim, tearing down its still-open response (and triggering a client retry
   * that re-meters the fan-out). `evictOldest` skips entries with `inFlight > 0`
   * so an active session is never the victim unless every session is busy.
   */
  inFlight: number;
}

// Idle sessions are evicted so a client that opens `initialize` sessions and
// walks away cannot leak transports until the (pinned, single-task) process
// OOMs. Touch-on-access keeps live conversations alive; the sweep closes the
// rest. Overridable for ops via MCP_SESSION_IDLE_TTL_SEC.
const SESSION_IDLE_TTL_MS =
  (Number(process.env.MCP_SESSION_IDLE_TTL_SEC) || 30 * 60) * 1000;
export const SESSION_SWEEP_INTERVAL_MS = 60_000;
// Hard ceiling on concurrently live sessions. Idle eviction only fires after
// SESSION_IDLE_TTL_MS, so without a cap a burst of cheap `initialize` calls
// (each creates a transport + server + client, with no upstream auth check)
// accumulates up to one TTL window of sessions and OOMs the pinned single task
// before the sweep prunes anything. The task is sized for ~50 concurrent
// sessions; the default leaves headroom while bounding burst growth. Override
// via MCP_MAX_SESSIONS.
const SESSION_MAX = Math.max(1, Number(process.env.MCP_MAX_SESSIONS) || 256);

/**
 * In-process session registry with idle eviction. `get` touches `lastSeen`, so
 * any POST/GET/DELETE on a session keeps it alive; `sweep` closes and drops the
 * ones idle past the TTL. Single-task only (per mcp.md): a multi-task rollout
 * still needs a shared store.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly maxSize: number = SESSION_MAX) {}

  get size(): number {
    return this.sessions.size;
  }

  get(id: string): SessionEntry | undefined {
    const entry = this.sessions.get(id);
    if (entry) entry.lastSeen = Date.now();
    return entry;
  }

  register(id: string, entry: SessionEntry): void {
    // Bound the live-session count so a burst of `initialize` calls can't grow
    // the Map without limit and OOM the pinned task before idle eviction kicks
    // in. At the cap, drop the least-recently-used session (oldest lastSeen):
    // normal concurrency stays well under the cap, so this only bites an
    // abnormal flood, where evicting the oldest (most likely abandoned) entry
    // is the right victim.
    if (!this.sessions.has(id) && this.sessions.size >= this.maxSize) {
      this.evictOldest();
    }
    this.sessions.set(id, entry);
  }

  /**
   * Close and drop a session to make room at the cap. Prefer the
   * least-recently-used IDLE session; only abort an in-flight one if every
   * session is busy. Without the inFlight skip, a session running a long heavy
   * tool has the stalest `lastSeen` and would be evicted mid-response.
   */
  private evictOldest(): void {
    let oldestId: string | undefined;
    let oldestSeen = Infinity;
    let oldestIdleId: string | undefined;
    let oldestIdleSeen = Infinity;
    for (const [id, entry] of this.sessions) {
      if (entry.lastSeen < oldestSeen) {
        oldestSeen = entry.lastSeen;
        oldestId = id;
      }
      if (entry.inFlight === 0 && entry.lastSeen < oldestIdleSeen) {
        oldestIdleSeen = entry.lastSeen;
        oldestIdleId = id;
      }
    }
    const victimId = oldestIdleId ?? oldestId;
    if (victimId !== undefined) {
      const victim = this.sessions.get(victimId)!;
      void Promise.resolve(victim.transport.close()).catch(() => undefined);
      this.sessions.delete(victimId);
    }
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  /** Close and drop every session idle longer than `ttlMs`. Returns the count evicted. */
  sweep(ttlMs: number = SESSION_IDLE_TTL_MS, now: number = Date.now()): number {
    let evicted = 0;
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastSeen > ttlMs) {
        void Promise.resolve(entry.transport.close()).catch(() => undefined);
        this.sessions.delete(id);
        evicted += 1;
      }
    }
    return evicted;
  }
}
