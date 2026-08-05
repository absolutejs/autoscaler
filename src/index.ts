/**
 * @absolutejs/autoscaler — horizontal-scaling policy substrate.
 *
 * The package contributes the **decision** half of a PaaS
 * autoscaler. The actuator half — actually provisioning a VM /
 * draining a pod / killing a process — lives in the control plane
 * via the `Actuator` interface, so the substrate stays cloud-
 * agnostic.
 *
 * Loop:
 *
 *   read signals → combine into a single score (0..1+) →
 *   compare against scaleUp / scaleDown thresholds →
 *   if past threshold and cooldown elapsed, ask actuator to
 *   spawn N / drain N / terminate N instances within min/max.
 *
 * Signals are pluggable: each returns a `score` and an `observed`
 * snapshot. Combine strategy defaults to `'max'` ("worst-pressure
 * wins" — the safe choice for elasticity), with `'avg'` and
 * a custom function as overrides.
 *
 * The substrate is intentionally narrow: no opinion on what a
 * "signal" really is, no opinion on what an "instance" really is.
 * That's why the same package fits a 10-VM fleet AND a 10000-isolate
 * fleet on one box AND a pod-per-tenant cluster — the actuator
 * defines what "instance" means.
 */

// =============================================================================
// Audit interface — narrow + optional
// =============================================================================

export type AutoscalerAuditLike = {
  append: (event: {
    kind: string;
    actor?: string;
    target?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void> | void;
};

// =============================================================================
// Signals
// =============================================================================

export type SignalReading = {
  /**
   * Normalized utilization in `[0, 1+]` where `1` = "100% of the
   * scale-up target." Going above 1 is allowed and represents
   * over-target pressure.
   */
  score: number;
  /**
   * Raw measurement the signal observed (CPU%, queue depth, latency
   * ms, etc.). Carried into audit events + decision metadata so an
   * operator can read what tripped the scaler.
   */
  observed?: Record<string, unknown>;
};

export type Signal = {
  name: string;
  /** Optional weight ≥ 0 used by `'avg'` combine. Defaults to 1. */
  weight?: number;
  /**
   * Read the current signal. Sync or async. Throws → counted as a
   * read failure but doesn't break the loop.
   */
  read: () => SignalReading | Promise<SignalReading>;
};

/**
 * Helper: build a signal whose score is `observed / target`. The
 * canonical shape for CPU%, memory%, queue depth, etc.
 */
export const ratioSignal = (
  name: string,
  target: number,
  read: () => number | Promise<number>,
  options: { weight?: number; observedKey?: string } = {},
): Signal => {
  const opts: Signal = {
    name,
    read: async () => {
      const value = await read();
      return {
        observed: { [options.observedKey ?? name]: value, target },
        score: target === 0 ? 0 : value / target,
      };
    },
  };
  if (options.weight !== undefined) opts.weight = options.weight;
  return opts;
};

// =============================================================================
// Policy
// =============================================================================

export type ScalingThreshold = {
  /** Pressure score that triggers the action. */
  threshold: number;
  /** Minimum ms between actions in this direction. Default 60_000. */
  cooldownMs?: number;
  /** Instances to add/remove per trigger. Default 1. */
  step?: number;
};

export type AutoscalerPolicy = {
  min: number;
  max: number;
  scaleUp: ScalingThreshold;
  scaleDown: ScalingThreshold;
};

export const createPolicy = (policy: AutoscalerPolicy): AutoscalerPolicy => {
  if (!Number.isInteger(policy.min) || policy.min < 0) {
    throw new Error(
      `autoscaler: min must be a non-negative integer (got ${policy.min})`,
    );
  }
  if (!Number.isInteger(policy.max) || policy.max < policy.min) {
    throw new Error(
      `autoscaler: max (${policy.max}) must be an integer >= min (${policy.min})`,
    );
  }
  if (policy.scaleDown.threshold >= policy.scaleUp.threshold) {
    throw new Error(
      `autoscaler: scaleDown threshold (${policy.scaleDown.threshold}) must be < scaleUp threshold (${policy.scaleUp.threshold}) — otherwise flapping`,
    );
  }
  if (policy.scaleUp.threshold <= 0) {
    throw new Error(`autoscaler: scaleUp threshold must be > 0`);
  }
  return policy;
};

// =============================================================================
// Actuator
// =============================================================================

export type Instance = {
  id: string;
  state: "pending" | "ready" | "draining" | "terminated";
  /** `Date.now()` when the actuator first reported this instance. */
  createdAt?: number;
  /** Free-form actuator metadata (region, ip, etc.). */
  metadata?: Record<string, unknown>;
};

export type Actuator = {
  /** Return the current fleet. Only `'pending'` and `'ready'` count toward capacity. */
  list: () => Promise<Instance[]> | Instance[];
  /**
   * Provision one new instance. Returns the new record; the
   * substrate doesn't poll for readiness — that's an actuator
   * concern (block in `spawn` or accept that `list()` will surface
   * the `'pending'` state until ready).
   */
  spawn: () => Promise<Instance> | Instance;
  /**
   * Stop sending new work to this instance. Returns once the
   * instance is marked `'draining'`. Implementations typically
   * remove the instance from the load balancer.
   */
  drain: (id: string) => Promise<void> | void;
  /**
   * Permanently remove the instance. Called AFTER `drain` returns.
   * Implementations actually destroy the VM / kill the process.
   */
  terminate: (id: string) => Promise<void> | void;
};

// =============================================================================
// Engine — evaluation + decision
// =============================================================================

export type CombineStrategy =
  | "max"
  | "avg"
  | ((
      readings: Array<{ signal: string; score: number; weight: number }>,
    ) => number);

export type Action = "scale-up" | "scale-down" | "hold";

export type Decision = {
  action: Action;
  score: number;
  currentCount: number;
  desiredCount: number;
  /** Why we picked this action (cooldown, threshold, min/max clamp). */
  reason: string;
  readings: Array<{
    signal: string;
    score: number;
    observed?: Record<string, unknown>;
    failed?: boolean;
    error?: string;
  }>;
  at: number;
};

export type AutoscalerOptions = {
  policy: AutoscalerPolicy;
  signals: Signal[];
  actuator: Actuator;
  /** Default `'max'` — worst-pressure wins. */
  combine?: CombineStrategy;
  /** Audit broker. Optional. */
  audit?: AutoscalerAuditLike;
  /** Tag every audit event with this actor (e.g. cluster id). */
  actor?: string;
  /** Period between automatic evaluations. Default 30_000 ms. */
  intervalMs?: number;
  /** Override `Date.now()` for tests. */
  clock?: () => number;
  /** Hook for unrecoverable internal failures. */
  onError?: (error: unknown) => void;
  /** Called after each evaluation with the resulting decision. */
  onDecision?: (decision: Decision) => void;
};

export type AutoscalerMetrics = {
  evaluations: number;
  scaleUps: number;
  scaleDowns: number;
  holds: number;
  errors: number;
  lastScore: number;
  lastAction: Action;
  lastAt: number;
};

export type Autoscaler = {
  /** Read signals + compute decision. Does NOT mutate the fleet. */
  evaluate: () => Promise<Decision>;
  /**
   * Apply one previously evaluated decision without reading signals again.
   * The live capacity must still equal `currentCount`, and callers may bound
   * the decision age. This is the plan/approve/apply primitive for control
   * planes that must execute the exact reviewed plan.
   */
  applyDecision: (
    decision: Decision,
    options?: { maxAgeMs?: number },
  ) => Promise<Decision>;
  /**
   * Read signals, compute decision, **apply** it via the actuator,
   * emit audit. Returns the (post-clamp, post-cooldown) decision.
   */
  step: () => Promise<Decision>;
  /** Start the periodic loop. No-op if already running. */
  start: () => void;
  /** Stop the periodic loop. */
  stop: () => void;
  /** Whether the loop is currently running. */
  running: () => boolean;
  metrics: () => AutoscalerMetrics;
};

export class StaleAutoscalerDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleAutoscalerDecisionError";
  }
}

const combineReadings = (
  strategy: CombineStrategy,
  readings: Array<{ signal: string; score: number; weight: number }>,
): number => {
  if (readings.length === 0) return 0;
  if (typeof strategy === "function") return strategy(readings);
  if (strategy === "max") {
    let max = -Infinity;
    for (const r of readings) if (r.score > max) max = r.score;
    return max === -Infinity ? 0 : max;
  }
  // 'avg' — weighted mean. Zero-weight rows are ignored.
  let sum = 0;
  let totalWeight = 0;
  for (const r of readings) {
    if (r.weight <= 0) continue;
    sum += r.score * r.weight;
    totalWeight += r.weight;
  }
  return totalWeight === 0 ? 0 : sum / totalWeight;
};

export const createAutoscaler = (options: AutoscalerOptions): Autoscaler => {
  const policy = createPolicy(options.policy);
  const combine = options.combine ?? "max";
  const intervalMs = options.intervalMs ?? 30_000;
  const clock = options.clock ?? Date.now;
  const onError = options.onError ?? ((e) => console.warn("[autoscaler]", e));
  const onDecision = options.onDecision;
  const scaleUpCooldown = policy.scaleUp.cooldownMs ?? 60_000;
  const scaleDownCooldown = policy.scaleDown.cooldownMs ?? 60_000;
  const scaleUpStep = policy.scaleUp.step ?? 1;
  const scaleDownStep = policy.scaleDown.step ?? 1;

  const metrics: AutoscalerMetrics = {
    errors: 0,
    evaluations: 0,
    holds: 0,
    lastAction: "hold",
    lastAt: 0,
    lastScore: 0,
    scaleDowns: 0,
    scaleUps: 0,
  };
  let lastScaleUpAt = -Infinity;
  let lastScaleDownAt = -Infinity;
  let timer: ReturnType<typeof setInterval> | undefined;

  const countCapacity = (instances: Instance[]): number => {
    let n = 0;
    for (const i of instances) {
      if (i.state === "ready" || i.state === "pending") n += 1;
    }
    return n;
  };

  const readAllSignals = async (): Promise<Decision["readings"]> => {
    const readings: Decision["readings"] = [];
    for (const signal of options.signals) {
      try {
        const reading = await signal.read();
        const entry: Decision["readings"][number] = {
          score: reading.score,
          signal: signal.name,
        };
        if (reading.observed !== undefined) entry.observed = reading.observed;
        readings.push(entry);
      } catch (e) {
        readings.push({
          error: e instanceof Error ? e.message : String(e),
          failed: true,
          score: 0,
          signal: signal.name,
        });
      }
    }
    return readings;
  };

  const evaluate = async (): Promise<Decision> => {
    const at = clock();
    const readings = await readAllSignals();
    const usable = readings
      .filter((r) => !r.failed)
      .map((r) => ({
        score: r.score,
        signal: r.signal,
        weight: options.signals.find((s) => s.name === r.signal)?.weight ?? 1,
      }));
    const score = combineReadings(combine, usable);

    const instances = await options.actuator.list();
    const list = Array.isArray(instances) ? instances : await instances;
    const currentCount = countCapacity(list);

    let action: Action = "hold";
    let desiredCount = currentCount;
    let reason = "within bands";

    // Capacity bounds are invariants, not utilization hints. Reconcile them
    // before thresholds and cooldowns so a cold fleet cannot remain below its
    // minimum and an externally enlarged fleet cannot remain above its maximum.
    if (currentCount < policy.min) {
      action = "scale-up";
      desiredCount = policy.min;
      reason = `below min instances (${currentCount} < ${policy.min})`;
    } else if (currentCount > policy.max) {
      action = "scale-down";
      desiredCount = policy.max;
      reason = `above max instances (${currentCount} > ${policy.max})`;
    } else if (score >= policy.scaleUp.threshold) {
      if (at - lastScaleUpAt < scaleUpCooldown) {
        reason = `scale-up cooldown (${Math.round(at - lastScaleUpAt)}ms < ${scaleUpCooldown}ms)`;
      } else if (currentCount >= policy.max) {
        reason = `at max instances (${policy.max})`;
      } else {
        action = "scale-up";
        desiredCount = Math.min(policy.max, currentCount + scaleUpStep);
        reason = `score ${score.toFixed(3)} >= ${policy.scaleUp.threshold}`;
      }
    } else if (score <= policy.scaleDown.threshold) {
      if (at - lastScaleDownAt < scaleDownCooldown) {
        reason = `scale-down cooldown (${Math.round(at - lastScaleDownAt)}ms < ${scaleDownCooldown}ms)`;
      } else if (currentCount <= policy.min) {
        reason = `at min instances (${policy.min})`;
      } else {
        action = "scale-down";
        desiredCount = Math.max(policy.min, currentCount - scaleDownStep);
        reason = `score ${score.toFixed(3)} <= ${policy.scaleDown.threshold}`;
      }
    }

    return {
      action,
      at,
      currentCount,
      desiredCount,
      reason,
      readings,
      score,
    };
  };

  const emitAudit = async (decision: Decision): Promise<void> => {
    if (options.audit === undefined) return;
    try {
      const event: Parameters<AutoscalerAuditLike["append"]>[0] = {
        kind: `autoscaler.${decision.action.replace("-", ".")}`,
        metadata: {
          currentCount: decision.currentCount,
          desiredCount: decision.desiredCount,
          reason: decision.reason,
          score: decision.score,
        },
      };
      if (options.actor !== undefined) event.actor = options.actor;
      await options.audit.append(event);
    } catch (e) {
      metrics.errors += 1;
      onError(e);
    }
  };

  const applyScaleUp = async (decision: Decision): Promise<void> => {
    const delta = decision.desiredCount - decision.currentCount;
    for (let i = 0; i < delta; i += 1) {
      try {
        await options.actuator.spawn();
      } catch (e) {
        metrics.errors += 1;
        onError(e);
      }
    }
    lastScaleUpAt = decision.at;
  };

  const applyScaleDown = async (decision: Decision): Promise<void> => {
    const delta = decision.currentCount - decision.desiredCount;
    if (delta <= 0) return;
    const list = await options.actuator.list();
    const all = Array.isArray(list) ? list : await list;
    // Drain newest-first (LIFO) so warmed instances live longer.
    const candidates = all
      .filter((i) => i.state === "ready" || i.state === "pending")
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, delta);
    for (const instance of candidates) {
      try {
        await options.actuator.drain(instance.id);
        await options.actuator.terminate(instance.id);
      } catch (e) {
        metrics.errors += 1;
        onError(e);
      }
    }
    lastScaleDownAt = decision.at;
  };

  const assertApplicable = async (
    decision: Decision,
    maxAgeMs: number | undefined,
  ) => {
    const at = clock();
    if (!Number.isFinite(decision.at) || decision.at > at)
      throw new StaleAutoscalerDecisionError(
        "autoscaler: decision timestamp is invalid",
      );
    if (maxAgeMs !== undefined && (!Number.isFinite(maxAgeMs) || maxAgeMs < 0))
      throw new Error("autoscaler: maxAgeMs must be a non-negative number");
    if (maxAgeMs !== undefined && at - decision.at > maxAgeMs)
      throw new StaleAutoscalerDecisionError(
        `autoscaler: decision is stale (${at - decision.at}ms > ${maxAgeMs}ms)`,
      );
    if (
      !Number.isInteger(decision.currentCount) ||
      !Number.isInteger(decision.desiredCount) ||
      decision.desiredCount < policy.min ||
      decision.desiredCount > policy.max
    )
      throw new StaleAutoscalerDecisionError(
        "autoscaler: decision capacity is outside policy",
      );
    const validDirection =
      (decision.action === "scale-up" &&
        decision.desiredCount > decision.currentCount) ||
      (decision.action === "scale-down" &&
        decision.desiredCount < decision.currentCount) ||
      (decision.action === "hold" &&
        decision.desiredCount === decision.currentCount);
    if (!validDirection)
      throw new StaleAutoscalerDecisionError(
        "autoscaler: decision action and capacity disagree",
      );
    const listed = await options.actuator.list();
    const liveCount = countCapacity(
      Array.isArray(listed) ? listed : await listed,
    );
    if (liveCount !== decision.currentCount)
      throw new StaleAutoscalerDecisionError(
        `autoscaler: fleet changed since evaluation (${decision.currentCount} planned, ${liveCount} live)`,
      );
  };

  const applyDecision = async (
    decision: Decision,
    applyOptions: { maxAgeMs?: number } = {},
  ): Promise<Decision> => {
    await assertApplicable(decision, applyOptions.maxAgeMs);
    metrics.evaluations += 1;
    metrics.lastScore = decision.score;
    metrics.lastAction = decision.action;
    metrics.lastAt = decision.at;

    if (decision.action === "scale-up") {
      await applyScaleUp(decision);
      metrics.scaleUps += 1;
    } else if (decision.action === "scale-down") {
      await applyScaleDown(decision);
      metrics.scaleDowns += 1;
    } else {
      metrics.holds += 1;
    }

    await emitAudit(decision);
    onDecision?.(decision);
    return decision;
  };

  const step = async (): Promise<Decision> => {
    const decision = await evaluate();

    return applyDecision(decision);
  };

  const start = (): void => {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      void step().catch((e) => {
        metrics.errors += 1;
        onError(e);
      });
    }, intervalMs);
  };

  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return {
    applyDecision,
    evaluate,
    metrics: () => ({ ...metrics }),
    running: () => timer !== undefined,
    start,
    step,
    stop,
  };
};
