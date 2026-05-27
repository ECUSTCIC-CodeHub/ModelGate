import { getGatewaySettings } from "@/lib/core/settings";

function isCircuitBreakerEnabled(): boolean {
  return getGatewaySettings().upstream_circuit_breaker_enabled === 1;
}

type ChannelRuntimeState = {
  inFlight: number;
  consecutiveFailures: number;
  circuitOpenUntil: number;
  latencyEwmaMs: number | null;
  maxConcurrency: number;
  queue: QueueWaiter[];
};

type ChannelRuntimeStore = Map<number, ChannelRuntimeState>;

type QueueWaiter = {
  resolve: (lease: ChannelLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type LeaseResult =
  | { ok: true; lease: ChannelLease; queued: boolean }
  | { ok: false; reason: "circuit_open" };

type AcquireResult =
  | { ok: true; lease: ChannelLease; queued: boolean }
  | { ok: false; reason: "circuit_open" | "queue_full" | "queue_timeout" };

const HARD_CONCURRENCY_LIMIT = 64;
const MAX_QUEUE_SIZE = 256;
const QUEUE_TIMEOUT_MS = 30_000;
const HALF_OPEN_MAX_PROBES = 1;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 15_000;
const LATENCY_EWMA_ALPHA = 0.2;

declare global {
  var __channelRuntimeStore__: ChannelRuntimeStore | undefined;
}

function getStore() {
  if (!globalThis.__channelRuntimeStore__) {
    globalThis.__channelRuntimeStore__ = new Map();
  }
  return globalThis.__channelRuntimeStore__;
}

function getState(channelId: number): ChannelRuntimeState {
  const store = getStore();
  const existing = store.get(channelId);
  if (existing) return existing;

  const created: ChannelRuntimeState = {
    inFlight: 0,
    consecutiveFailures: 0,
    circuitOpenUntil: 0,
    latencyEwmaMs: null,
    maxConcurrency: HARD_CONCURRENCY_LIMIT,
    queue: [],
  };
  store.set(channelId, created);
  return created;
}

function normalizeMaxConcurrency(value: number) {
  return Math.max(1, Math.floor(value || 1));
}

function syncStateConfig(state: ChannelRuntimeState, maxConcurrency: number) {
  state.maxConcurrency = normalizeMaxConcurrency(maxConcurrency);
}

function updateLatencyEwma(state: ChannelRuntimeState, latencyMs: number) {
  const normalized = Math.max(1, latencyMs);
  state.latencyEwmaMs =
    state.latencyEwmaMs === null
      ? normalized
      : state.latencyEwmaMs * (1 - LATENCY_EWMA_ALPHA) + normalized * LATENCY_EWMA_ALPHA;
}

function getEffectiveLimit(state: ChannelRuntimeState) {
  const now = Date.now();
  const halfOpen = state.circuitOpenUntil !== 0 && state.circuitOpenUntil <= now;
  return halfOpen ? Math.min(state.maxConcurrency, HALF_OPEN_MAX_PROBES) : state.maxConcurrency;
}

function grantLease(channelId: number, state: ChannelRuntimeState, queued: boolean) {
  state.inFlight += 1;
  return { ok: true as const, lease: new ChannelLease(channelId, state), queued };
}

function drainQueue(channelId: number, state: ChannelRuntimeState) {
  while (state.queue.length > 0 && state.inFlight < getEffectiveLimit(state)) {
    const waiter = state.queue.shift();
    if (!waiter) break;
    if (waiter.signal?.aborted) continue;
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.resolve(grantLease(channelId, state, true).lease);
  }
}

function releaseLease(state: ChannelRuntimeState) {
  state.inFlight = Math.max(0, state.inFlight - 1);
}

export class ChannelLease {
  private released = false;

  constructor(
    readonly channelId: number,
    private readonly state: ChannelRuntimeState,
  ) {}

  complete(result: { ok: boolean; latencyMs: number }) {
    if (this.released) return;

    updateLatencyEwma(this.state, result.latencyMs);

    if (result.ok) {
      this.state.consecutiveFailures = 0;
      this.state.circuitOpenUntil = 0;
    } else if (isCircuitBreakerEnabled()) {
      this.state.consecutiveFailures += 1;
      if (this.state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
        this.state.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
      }
    }

    this.released = true;
    releaseLease(this.state);
    drainQueue(this.channelId, this.state);
  }

  abandon() {
    if (this.released) return;
    this.released = true;
    releaseLease(this.state);
    drainQueue(this.channelId, this.state);
  }
}

export function tryAcquireChannel(channelId: number, maxConcurrency: number): LeaseResult {
  const state = getState(channelId);
  syncStateConfig(state, maxConcurrency);
  const now = Date.now();

  if (isCircuitBreakerEnabled() && state.circuitOpenUntil > now) {
    return { ok: false, reason: "circuit_open" };
  }

  if (state.inFlight >= getEffectiveLimit(state)) {
    return { ok: false, reason: "circuit_open" };
  }

  return grantLease(channelId, state, false);
}

export function acquireChannel(channelId: number, maxConcurrency: number, signal?: AbortSignal): AcquireResult | Promise<AcquireResult> {
  const state = getState(channelId);
  syncStateConfig(state, maxConcurrency);
  const now = Date.now();

  if (isCircuitBreakerEnabled() && state.circuitOpenUntil > now) {
    return { ok: false, reason: "circuit_open" };
  }

  if (state.inFlight < getEffectiveLimit(state)) {
    return grantLease(channelId, state, false);
  }

  if (state.queue.length >= MAX_QUEUE_SIZE) {
    return { ok: false, reason: "queue_full" };
  }

  return new Promise<AcquireResult>((resolve, reject) => {
    let settled = false;
    const waiter: QueueWaiter = {
      resolve: (lease) => {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, lease, queued: true });
      },
      reject,
      signal,
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      state.queue = state.queue.filter((item) => item !== waiter);
      if (waiter.onAbort && signal) signal.removeEventListener("abort", waiter.onAbort);
      resolve({ ok: false, reason: "queue_timeout" });
    }, QUEUE_TIMEOUT_MS);

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve({ ok: false, reason: "circuit_open" });
        return;
      }

      waiter.onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.queue = state.queue.filter((item) => item !== waiter);
        reject(new Error("Request aborted while waiting for channel queue."));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }

    state.queue.push(waiter);
  });
}

export function scoreChannel(channelId: number, staticWeight: number, maxConcurrency: number) {
  const state = getState(channelId);
  syncStateConfig(state, maxConcurrency);
  const now = Date.now();

  if (isCircuitBreakerEnabled() && state.circuitOpenUntil > now) {
    return 0;
  }

  const loadPenalty = Math.max(0.15, 1 - state.inFlight / Math.max(1, state.maxConcurrency));
  const failurePenalty = 1 / (1 + state.consecutiveFailures * 0.6);
  const latencyPenalty =
    state.latencyEwmaMs === null ? 1 : Math.max(0.35, Math.min(1.15, 1500 / state.latencyEwmaMs));

  return Math.max(1, staticWeight) * loadPenalty * failurePenalty * latencyPenalty;
}
