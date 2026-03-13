type ChannelRuntimeState = {
  inFlight: number;
  consecutiveFailures: number;
  circuitOpenUntil: number;
  latencyEwmaMs: number | null;
};

type ChannelRuntimeStore = Map<number, ChannelRuntimeState>;

type LeaseResult =
  | { ok: true; lease: ChannelLease }
  | { ok: false; reason: "circuit_open" | "channel_busy" };

const HARD_CONCURRENCY_LIMIT = 64;
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
  };
  store.set(channelId, created);
  return created;
}

function updateLatencyEwma(state: ChannelRuntimeState, latencyMs: number) {
  const normalized = Math.max(1, latencyMs);
  state.latencyEwmaMs =
    state.latencyEwmaMs === null
      ? normalized
      : state.latencyEwmaMs * (1 - LATENCY_EWMA_ALPHA) + normalized * LATENCY_EWMA_ALPHA;
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
    } else {
      this.state.consecutiveFailures += 1;
      if (this.state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
        this.state.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
      }
    }

    this.released = true;
    releaseLease(this.state);
  }

  abandon() {
    if (this.released) return;
    this.released = true;
    releaseLease(this.state);
  }
}

export function tryAcquireChannel(channelId: number): LeaseResult {
  const state = getState(channelId);
  const now = Date.now();

  if (state.circuitOpenUntil > now) {
    return { ok: false, reason: "circuit_open" };
  }

  const halfOpen = state.circuitOpenUntil !== 0 && state.circuitOpenUntil <= now;
  const limit = halfOpen ? HALF_OPEN_MAX_PROBES : HARD_CONCURRENCY_LIMIT;

  if (state.inFlight >= limit) {
    return { ok: false, reason: "channel_busy" };
  }

  state.inFlight += 1;
  return { ok: true, lease: new ChannelLease(channelId, state) };
}

export function scoreChannel(channelId: number, staticWeight: number) {
  const state = getState(channelId);
  const now = Date.now();

  if (state.circuitOpenUntil > now) {
    return 0;
  }

  const loadPenalty = Math.max(0.15, 1 - state.inFlight / HARD_CONCURRENCY_LIMIT);
  const failurePenalty = 1 / (1 + state.consecutiveFailures * 0.6);
  const latencyPenalty =
    state.latencyEwmaMs === null ? 1 : Math.max(0.35, Math.min(1.15, 1500 / state.latencyEwmaMs));

  return Math.max(1, staticWeight) * loadPenalty * failurePenalty * latencyPenalty;
}
