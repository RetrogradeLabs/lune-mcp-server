/**
 * Unit coverage for `SessionStore` (src/transport/streamableHttp.ts): the
 * in-process session registry with touch-on-access, an LRU hard cap, idle
 * sweeping, and explicit delete. These drive the store directly with fake
 * transports ({ close: vi.fn() }) and either fake timers or explicit `now`
 * arguments, so every assertion pins observable behavior (entry identity,
 * size, close() calls, evicted count) and fails if the logic is reverted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../../src/transport/streamableHttp.js';

type FakeTransport = { close: ReturnType<typeof vi.fn> };

/** A SessionEntry-shaped object with a spyable `close`, cast for the store. */
function fakeEntry(lastSeen: number): {
  entry: Parameters<SessionStore['register']>[1];
  close: FakeTransport['close'];
} {
  const close = vi.fn().mockResolvedValue(undefined);
  const transport: FakeTransport = { close };
  return {
    entry: { transport: transport as never, token: 'lune_test', lastSeen },
    close,
  };
}

describe('SessionStore register/get/delete', () => {
  it('register then get returns the same entry', () => {
    const store = new SessionStore(4);
    const a = fakeEntry(1_000);
    store.register('a', a.entry);

    expect(store.size).toBe(1);
    expect(store.get('a')).toBe(a.entry);
  });

  it('get refreshes lastSeen to the current clock on access', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const store = new SessionStore(4);
    const a = fakeEntry(1_000);
    store.register('a', a.entry);
    expect(a.entry.lastSeen).toBe(1_000);

    // Access at a later wall-clock instant; get() must bump lastSeen to now.
    vi.setSystemTime(9_999);
    const got = store.get('a');

    expect(got).toBe(a.entry);
    expect(a.entry.lastSeen).toBe(9_999);
  });

  it('get on an unknown id returns undefined and does not grow the store', () => {
    const store = new SessionStore(4);
    expect(store.get('nope')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('delete removes an entry; a subsequent get is undefined', () => {
    const store = new SessionStore(4);
    const a = fakeEntry(1_000);
    store.register('a', a.entry);
    expect(store.size).toBe(1);

    store.delete('a');

    expect(store.size).toBe(0);
    expect(store.get('a')).toBeUndefined();
    // delete is a Map drop, not a transport teardown: it must NOT close().
    expect(a.close).not.toHaveBeenCalled();
  });

  it('delete of an unknown id is a no-op and leaves live entries intact', () => {
    const store = new SessionStore(4);
    const a = fakeEntry(1_000);
    store.register('a', a.entry);

    store.delete('ghost');

    expect(store.size).toBe(1);
    expect(store.get('a')).toBe(a.entry);
  });

  it('re-registering the same id replaces the entry without evicting at the cap', () => {
    // size stays at the cap (1) and no LRU eviction fires, because the guard is
    // `!has(id) && size >= maxSize`: an update to an existing id skips eviction.
    const store = new SessionStore(1);
    const first = fakeEntry(1_000);
    const second = fakeEntry(2_000);
    store.register('a', first.entry);
    store.register('a', second.entry);

    expect(store.size).toBe(1);
    expect(store.get('a')).toBe(second.entry);
    expect(first.close).not.toHaveBeenCalled();
  });
});

describe('SessionStore LRU cap (evictOldest)', () => {
  it('at the cap, a new id evicts and closes the least-recently-seen victim', () => {
    const store = new SessionStore(2);
    const a = fakeEntry(1_000); // oldest by lastSeen -> the victim
    const b = fakeEntry(2_000);
    const c = fakeEntry(3_000); // newest, triggers the eviction
    store.register('a', a.entry);
    store.register('b', b.entry);
    expect(store.size).toBe(2);

    store.register('c', c.entry);

    expect(store.size).toBe(2);
    expect(a.close).toHaveBeenCalledOnce();
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBe(b.entry);
    expect(store.get('c')).toBe(c.entry);
  });

  it('touch-on-access changes the victim: get() spares the otherwise-oldest entry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const store = new SessionStore(2);
    const a = fakeEntry(1_000); // would be the victim by raw lastSeen
    const b = fakeEntry(2_000);
    store.register('a', a.entry);
    store.register('b', b.entry);

    // Touch 'a' so it becomes the most-recently-seen; 'b' is now the oldest.
    vi.setSystemTime(20_000);
    store.get('a');
    const c = fakeEntry(30_000);
    store.register('c', c.entry);

    expect(b.close).toHaveBeenCalledOnce();
    expect(a.close).not.toHaveBeenCalled();
    expect(store.get('b')).toBeUndefined();
    expect(store.get('a')).toBe(a.entry);
    expect(store.get('c')).toBe(c.entry);
  });

  it('does not evict while strictly below the cap', () => {
    const store = new SessionStore(3);
    const a = fakeEntry(1_000);
    const b = fakeEntry(2_000);
    store.register('a', a.entry);
    store.register('b', b.entry);

    expect(store.size).toBe(2);
    expect(a.close).not.toHaveBeenCalled();
    expect(b.close).not.toHaveBeenCalled();
  });

  it('a maxSize of 1 keeps only the newest session, closing each prior one', () => {
    const store = new SessionStore(1);
    const a = fakeEntry(1_000);
    const b = fakeEntry(2_000);
    store.register('a', a.entry);
    store.register('b', b.entry);

    expect(store.size).toBe(1);
    expect(a.close).toHaveBeenCalledOnce();
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBe(b.entry);
  });
});

describe('SessionStore.sweep idle eviction', () => {
  it('closes and drops entries idle beyond the ttl, returns the evicted count', () => {
    const store = new SessionStore(8);
    const now = 1_000_000;
    const stale = fakeEntry(now - 10_000); // idle 10s
    const fresh = fakeEntry(now - 100); // idle 0.1s
    store.register('stale', stale.entry);
    store.register('fresh', fresh.entry);

    const evicted = store.sweep(5_000, now);

    expect(evicted).toBe(1);
    expect(stale.close).toHaveBeenCalledOnce();
    expect(fresh.close).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
    expect(store.get('fresh')).toBe(fresh.entry);
    expect(store.get('stale')).toBeUndefined();
  });

  it('treats idle exactly at the ttl boundary as still-live (strict greater-than)', () => {
    // The predicate is `now - lastSeen > ttlMs`, so an entry idle for exactly
    // ttlMs survives; only strictly-older entries are evicted.
    const store = new SessionStore(8);
    const now = 2_000_000;
    const boundary = fakeEntry(now - 5_000); // idle == ttl
    store.register('boundary', boundary.entry);

    expect(store.sweep(5_000, now)).toBe(0);
    expect(boundary.close).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
  });

  it('an empty store sweeps to zero with no teardown', () => {
    const store = new SessionStore(8);
    expect(store.sweep(1_000, 1_000_000)).toBe(0);
    expect(store.size).toBe(0);
  });

  it('evicts every entry when all are idle past the ttl', () => {
    const store = new SessionStore(8);
    const now = 3_000_000;
    const a = fakeEntry(now - 60_000);
    const b = fakeEntry(now - 90_000);
    store.register('a', a.entry);
    store.register('b', b.entry);

    expect(store.sweep(30_000, now)).toBe(2);
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    expect(store.size).toBe(0);
  });

  it('uses the real clock for sweep when now is omitted (fake timers)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const store = new SessionStore(8);
    // Register at the current fake clock; get() stamps lastSeen = 1_000_000.
    store.register('a', fakeEntry(0).entry);
    store.get('a');

    // Advance the clock well past the ttl, then sweep with no explicit `now`.
    vi.setSystemTime(1_000_000 + 120_000);
    expect(store.sweep(60_000)).toBe(1);
    expect(store.size).toBe(0);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useRealTimers();
});
