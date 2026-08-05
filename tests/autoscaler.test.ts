import { describe, expect, test } from "bun:test";
import {
  createAutoscaler,
  createPolicy,
  ratioSignal,
  StaleAutoscalerDecisionError,
  type Actuator,
  type AutoscalerAuditLike,
  type Instance,
  type Signal,
} from "../src/index";

// =============================================================================
// Mocks
// =============================================================================

const makeAudit = (): {
  audit: AutoscalerAuditLike;
  events: Array<{
    kind: string;
    actor?: string;
    target?: string;
    metadata?: Record<string, unknown>;
  }>;
} => {
  const events: Array<{
    kind: string;
    actor?: string;
    target?: string;
    metadata?: Record<string, unknown>;
  }> = [];
  return {
    audit: { append: async (e) => void events.push(e) },
    events,
  };
};

const makeActuator = (
  initial: Instance[] = [],
): {
  actuator: Actuator;
  instances: Instance[];
  spawns: number;
  drains: string[];
  terminations: string[];
} => {
  const state = {
    drains: [] as string[],
    instances: [...initial],
    spawns: 0,
    terminations: [] as string[],
  };
  let counter = state.instances.length;
  const actuator: Actuator = {
    drain: (id) => {
      state.drains.push(id);
      const i = state.instances.find((x) => x.id === id);
      if (i !== undefined) i.state = "draining";
    },
    list: () => state.instances,
    spawn: () => {
      counter += 1;
      const inst: Instance = {
        createdAt: counter,
        id: `i-${counter}`,
        state: "ready",
      };
      state.instances.push(inst);
      state.spawns += 1;
      return inst;
    },
    terminate: (id) => {
      state.terminations.push(id);
      state.instances = state.instances.filter((x) => x.id !== id);
    },
  };
  return {
    actuator,
    get drains() {
      return state.drains;
    },
    get instances() {
      return state.instances;
    },
    get spawns() {
      return state.spawns;
    },
    get terminations() {
      return state.terminations;
    },
  } as ReturnType<typeof makeActuator>;
};

const constSignal = (name: string, score: number, weight?: number): Signal => {
  const s: Signal = {
    name,
    read: () => ({ observed: { value: score }, score }),
  };
  if (weight !== undefined) s.weight = weight;
  return s;
};

// =============================================================================
// createPolicy validation
// =============================================================================

describe("createPolicy", () => {
  test("returns the policy when valid", () => {
    const p = createPolicy({
      max: 5,
      min: 1,
      scaleDown: { threshold: 0.3 },
      scaleUp: { threshold: 0.7 },
    });
    expect(p.max).toBe(5);
  });

  test("rejects min < 0", () => {
    expect(() =>
      createPolicy({
        max: 5,
        min: -1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
    ).toThrow();
  });

  test("rejects max < min", () => {
    expect(() =>
      createPolicy({
        max: 1,
        min: 5,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
    ).toThrow();
  });

  test("rejects overlapping thresholds (would flap)", () => {
    expect(() =>
      createPolicy({
        max: 5,
        min: 1,
        scaleDown: { threshold: 0.8 },
        scaleUp: { threshold: 0.7 },
      }),
    ).toThrow("flapping");
  });

  test("rejects scaleUp threshold <= 0", () => {
    expect(() =>
      createPolicy({
        max: 5,
        min: 1,
        scaleDown: { threshold: -1 },
        scaleUp: { threshold: 0 },
      }),
    ).toThrow();
  });
});

// =============================================================================
// ratioSignal
// =============================================================================

describe("ratioSignal", () => {
  test("score = observed / target", async () => {
    const sig = ratioSignal("cpu", 0.8, () => 0.4);
    const r = await sig.read();
    expect(r.score).toBeCloseTo(0.5);
    expect(r.observed?.cpu).toBe(0.4);
    expect(r.observed?.target).toBe(0.8);
  });

  test("target = 0 → score = 0 (no divide-by-zero)", async () => {
    const sig = ratioSignal("zero", 0, () => 99);
    const r = await sig.read();
    expect(r.score).toBe(0);
  });

  test("custom observedKey", async () => {
    const sig = ratioSignal("q", 100, () => 50, { observedKey: "queueDepth" });
    const r = await sig.read();
    expect(r.observed?.queueDepth).toBe(50);
  });

  test("weight propagates", async () => {
    const sig = ratioSignal("cpu", 1, () => 0.5, { weight: 2 });
    expect(sig.weight).toBe(2);
  });
});

// =============================================================================
// evaluate — decisions without mutating
// =============================================================================

describe("evaluate", () => {
  test("signals above scaleUp threshold → scale-up action", async () => {
    const { actuator } = makeActuator([
      { createdAt: 1, id: "i-1", state: "ready" },
    ]);
    const scaler = createAutoscaler({
      actuator,
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("hot", 0.9)],
    });
    const d = await scaler.evaluate();
    expect(d.action).toBe("scale-up");
    expect(d.score).toBe(0.9);
    expect(d.desiredCount).toBe(2);
    expect(d.reason).toContain(">=");
  });

  test("signals below scaleDown threshold → scale-down action", async () => {
    const { actuator } = makeActuator([
      { createdAt: 1, id: "i-1", state: "ready" },
      { createdAt: 2, id: "i-2", state: "ready" },
      { createdAt: 3, id: "i-3", state: "ready" },
    ]);
    const scaler = createAutoscaler({
      actuator,
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("cold", 0.1)],
    });
    const d = await scaler.evaluate();
    expect(d.action).toBe("scale-down");
    expect(d.desiredCount).toBe(2);
  });

  test("between thresholds → hold", async () => {
    const { actuator } = makeActuator([
      { createdAt: 1, id: "i-1", state: "ready" },
    ]);
    const scaler = createAutoscaler({
      actuator,
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("warm", 0.5)],
    });
    const d = await scaler.evaluate();
    expect(d.action).toBe("hold");
    expect(d.reason).toBe("within bands");
  });

  test("below min → restore the hard minimum regardless of pressure", async () => {
    const { actuator } = makeActuator([
      { createdAt: 1, id: "i-1", state: "ready" },
    ]);
    const scaler = createAutoscaler({
      actuator,
      policy: createPolicy({
        max: 5,
        min: 3,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("warm", 0.5)],
    });

    const d = await scaler.evaluate();

    expect(d.action).toBe("scale-up");
    expect(d.currentCount).toBe(1);
    expect(d.desiredCount).toBe(3);
    expect(d.reason).toContain("below min");
  });

  test("above max → restore the hard maximum regardless of pressure", async () => {
    const { actuator } = makeActuator([
      { createdAt: 1, id: "i-1", state: "ready" },
      { createdAt: 2, id: "i-2", state: "ready" },
      { createdAt: 3, id: "i-3", state: "ready" },
    ]);
    const scaler = createAutoscaler({
      actuator,
      policy: createPolicy({
        max: 2,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("warm", 0.5)],
    });

    const d = await scaler.evaluate();

    expect(d.action).toBe("scale-down");
    expect(d.currentCount).toBe(3);
    expect(d.desiredCount).toBe(2);
    expect(d.reason).toContain("above max");
  });

  test("at max → hold instead of scale-up", async () => {
    const { actuator } = makeActuator([
      { createdAt: 1, id: "i-1", state: "ready" },
      { createdAt: 2, id: "i-2", state: "ready" },
    ]);
    const scaler = createAutoscaler({
      actuator,
      policy: createPolicy({
        max: 2,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("hot", 0.95)],
    });
    const d = await scaler.evaluate();
    expect(d.action).toBe("hold");
    expect(d.reason).toContain("max");
  });

  test("at min → hold instead of scale-down", async () => {
    const { actuator } = makeActuator([
      { createdAt: 1, id: "i-1", state: "ready" },
    ]);
    const scaler = createAutoscaler({
      actuator,
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("cold", 0.05)],
    });
    const d = await scaler.evaluate();
    expect(d.action).toBe("hold");
    expect(d.reason).toContain("min");
  });

  test("pending instances count toward capacity", async () => {
    const { actuator } = makeActuator([
      { createdAt: 1, id: "i-1", state: "ready" },
      { createdAt: 2, id: "i-2", state: "pending" },
      { createdAt: 3, id: "i-3", state: "terminated" },
    ]);
    const scaler = createAutoscaler({
      actuator,
      policy: createPolicy({
        max: 2,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("hot", 0.9)],
    });
    const d = await scaler.evaluate();
    expect(d.currentCount).toBe(2); // pending + ready, NOT terminated
    expect(d.action).toBe("hold");
  });

  test("a signal throwing is captured, others continue", async () => {
    const { actuator } = makeActuator([
      { createdAt: 1, id: "i-1", state: "ready" },
    ]);
    const scaler = createAutoscaler({
      actuator,
      combine: "max",
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [
        {
          name: "broken",
          read: () => {
            throw new Error("signal-dead");
          },
        },
        constSignal("ok", 0.9),
      ],
    });
    const d = await scaler.evaluate();
    expect(d.action).toBe("scale-up");
    const failed = d.readings.find((r) => r.signal === "broken");
    expect(failed?.failed).toBe(true);
    expect(failed?.error).toBe("signal-dead");
  });

  test("no signals → score 0 → no action (hold at min)", async () => {
    const { actuator } = makeActuator([
      { createdAt: 1, id: "i-1", state: "ready" },
    ]);
    const scaler = createAutoscaler({
      actuator,
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [],
    });
    const d = await scaler.evaluate();
    expect(d.score).toBe(0);
    expect(d.action).toBe("hold");
  });
});

// =============================================================================
// combine strategies
// =============================================================================

describe("combine strategies", () => {
  const { actuator } = makeActuator([
    { createdAt: 1, id: "i-1", state: "ready" },
  ]);
  const policy = createPolicy({
    max: 5,
    min: 1,
    scaleDown: { threshold: 0.3 },
    scaleUp: { threshold: 0.7 },
  });

  test("'max' picks the worst pressure", async () => {
    const scaler = createAutoscaler({
      actuator,
      combine: "max",
      policy,
      signals: [constSignal("a", 0.2), constSignal("b", 0.95)],
    });
    const d = await scaler.evaluate();
    expect(d.score).toBe(0.95);
    expect(d.action).toBe("scale-up");
  });

  test("'avg' weights by signal.weight", async () => {
    const scaler = createAutoscaler({
      actuator,
      combine: "avg",
      policy,
      signals: [constSignal("a", 0.2, 1), constSignal("b", 0.8, 3)],
    });
    const d = await scaler.evaluate();
    // (0.2 * 1 + 0.8 * 3) / 4 = 0.65 — between thresholds → hold
    expect(d.score).toBeCloseTo(0.65);
    expect(d.action).toBe("hold");
  });

  test("'avg' with zero weights ignores those signals", async () => {
    const scaler = createAutoscaler({
      actuator,
      combine: "avg",
      policy,
      signals: [constSignal("a", 0.95, 1), constSignal("b", 0.1, 0)],
    });
    const d = await scaler.evaluate();
    expect(d.score).toBeCloseTo(0.95);
    expect(d.action).toBe("scale-up");
  });

  test("custom combine function wins", async () => {
    const scaler = createAutoscaler({
      actuator,
      combine: () => 0.999, // ignore everything
      policy,
      signals: [constSignal("a", 0.1)],
    });
    const d = await scaler.evaluate();
    expect(d.score).toBeCloseTo(0.999);
    expect(d.action).toBe("scale-up");
  });
});

// =============================================================================
// step — applies decision to actuator
// =============================================================================

describe("step", () => {
  test("scale-up calls actuator.spawn `delta` times", async () => {
    const wrapped = makeActuator([{ createdAt: 1, id: "i-1", state: "ready" }]);
    const scaler = createAutoscaler({
      actuator: wrapped.actuator,
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { step: 3, threshold: 0.7 },
      }),
      signals: [constSignal("hot", 0.95)],
    });
    await scaler.step();
    expect(wrapped.spawns).toBe(3);
    expect(wrapped.instances.length).toBe(4);
  });

  test("scale-up clamps spawn count to max", async () => {
    const wrapped = makeActuator([{ createdAt: 1, id: "i-1", state: "ready" }]);
    const scaler = createAutoscaler({
      actuator: wrapped.actuator,
      policy: createPolicy({
        max: 2,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { step: 10, threshold: 0.7 },
      }),
      signals: [constSignal("hot", 0.95)],
    });
    await scaler.step();
    expect(wrapped.spawns).toBe(1);
    expect(wrapped.instances.length).toBe(2);
  });

  test("scale-down drains then terminates newest-first", async () => {
    const wrapped = makeActuator([
      { createdAt: 1, id: "old", state: "ready" },
      { createdAt: 2, id: "mid", state: "ready" },
      { createdAt: 3, id: "new", state: "ready" },
    ]);
    const scaler = createAutoscaler({
      actuator: wrapped.actuator,
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { step: 2, threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("cold", 0.05)],
    });
    await scaler.step();
    // Drained newest 2: 'new' and 'mid'
    expect(wrapped.drains).toEqual(["new", "mid"]);
    expect(wrapped.terminations).toEqual(["new", "mid"]);
    expect(wrapped.instances.map((i) => i.id)).toEqual(["old"]);
  });

  test("spawn failures are captured but loop continues", async () => {
    const errors: unknown[] = [];
    const failingActuator: Actuator = {
      drain: () => {},
      list: () => [{ createdAt: 1, id: "i-1", state: "ready" }],
      spawn: () => {
        throw new Error("quota exceeded");
      },
      terminate: () => {},
    };
    const scaler = createAutoscaler({
      actuator: failingActuator,
      onError: (e) => errors.push(e),
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("hot", 0.95)],
    });
    const decision = await scaler.step();
    expect(decision.action).toBe("scale-up");
    expect(errors).toHaveLength(1);
    expect(scaler.metrics().errors).toBe(1);
  });
});

describe("applyDecision", () => {
  test("applies the exact evaluated plan without reading signals again", async () => {
    let reads = 0;
    const wrapped = makeActuator([{ createdAt: 1, id: "i-1", state: "ready" }]);
    const scaler = createAutoscaler({
      actuator: wrapped.actuator,
      policy: createPolicy({
        max: 3,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [
        {
          name: "pressure",
          read: () => {
            reads += 1;

            return { score: reads === 1 ? 0.9 : 0.1 };
          },
        },
      ],
    });
    const plan = await scaler.evaluate();

    await scaler.applyDecision(plan);

    expect(reads).toBe(1);
    expect(wrapped.spawns).toBe(1);
  });

  test("rejects a plan after live capacity changes", async () => {
    const wrapped = makeActuator([{ createdAt: 1, id: "i-1", state: "ready" }]);
    const scaler = createAutoscaler({
      actuator: wrapped.actuator,
      policy: createPolicy({
        max: 3,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("hot", 0.9)],
    });
    const plan = await scaler.evaluate();
    wrapped.instances.push({ id: "external", state: "ready" });

    await expect(scaler.applyDecision(plan)).rejects.toBeInstanceOf(
      StaleAutoscalerDecisionError,
    );
    expect(wrapped.spawns).toBe(0);
  });

  test("enforces a caller-selected plan lifetime", async () => {
    let now = 1_000;
    const wrapped = makeActuator([{ createdAt: 1, id: "i-1", state: "ready" }]);
    const scaler = createAutoscaler({
      actuator: wrapped.actuator,
      clock: () => now,
      policy: createPolicy({
        max: 3,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("hot", 0.9)],
    });
    const plan = await scaler.evaluate();
    now += 101;

    await expect(
      scaler.applyDecision(plan, { maxAgeMs: 100 }),
    ).rejects.toBeInstanceOf(StaleAutoscalerDecisionError);
  });
});

// =============================================================================
// Cooldowns
// =============================================================================

describe("cooldowns", () => {
  test("scale-up respects cooldown", async () => {
    let now = 1_000_000;
    const wrapped = makeActuator([{ createdAt: 1, id: "i-1", state: "ready" }]);
    const scaler = createAutoscaler({
      actuator: wrapped.actuator,
      clock: () => now,
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { cooldownMs: 30_000, threshold: 0.7 },
      }),
      signals: [constSignal("hot", 0.95)],
    });
    const a = await scaler.step();
    expect(a.action).toBe("scale-up");
    now += 5_000;
    const b = await scaler.step();
    expect(b.action).toBe("hold");
    expect(b.reason).toContain("cooldown");
    now += 30_000;
    const c = await scaler.step();
    expect(c.action).toBe("scale-up");
  });

  test("scale-down respects cooldown", async () => {
    let now = 1_000_000;
    const wrapped = makeActuator([
      { createdAt: 1, id: "a", state: "ready" },
      { createdAt: 2, id: "b", state: "ready" },
      { createdAt: 3, id: "c", state: "ready" },
    ]);
    const scaler = createAutoscaler({
      actuator: wrapped.actuator,
      clock: () => now,
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { cooldownMs: 60_000, threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("cold", 0.05)],
    });
    await scaler.step();
    now += 1_000;
    const b = await scaler.step();
    expect(b.action).toBe("hold");
    expect(b.reason).toContain("cooldown");
  });

  test("scale-up cooldown does NOT block scale-down (independent timers)", async () => {
    let now = 1_000_000;
    const wrapped = makeActuator([{ createdAt: 1, id: "i-1", state: "ready" }]);
    let score = 0.95;
    const scaler = createAutoscaler({
      actuator: wrapped.actuator,
      clock: () => now,
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { cooldownMs: 60_000, threshold: 0.3 },
        scaleUp: { cooldownMs: 60_000, threshold: 0.7 },
      }),
      signals: [{ name: "s", read: () => ({ score }) }],
    });
    await scaler.step(); // scale-up
    // flip the load and scale-down should fire immediately (separate timer)
    score = 0.05;
    const wrapped2 = wrapped; // keep reference
    now += 1_000;
    const d = await scaler.step();
    // At step #2, we now have 2 instances; cold; not in scale-down
    // cooldown — should scale down.
    expect(d.action).toBe("scale-down");
    void wrapped2;
  });
});

// =============================================================================
// Audit + metrics
// =============================================================================

describe("audit + metrics", () => {
  test("emits an audit event per applied decision", async () => {
    const { actuator } = makeActuator([
      { createdAt: 1, id: "i-1", state: "ready" },
    ]);
    const { audit, events } = makeAudit();
    const scaler = createAutoscaler({
      actor: "cluster-1",
      actuator,
      audit,
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("hot", 0.95)],
    });
    await scaler.step();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("autoscaler.scale.up");
    expect(events[0]?.actor).toBe("cluster-1");
    expect(events[0]?.metadata?.score).toBeCloseTo(0.95);
  });

  test("hold also emits an audit event (audit trail is complete)", async () => {
    const { actuator } = makeActuator([
      { createdAt: 1, id: "i-1", state: "ready" },
    ]);
    const { audit, events } = makeAudit();
    const scaler = createAutoscaler({
      actuator,
      audit,
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("warm", 0.5)],
    });
    await scaler.step();
    expect(events[0]?.kind).toBe("autoscaler.hold");
  });

  test("audit broker throwing is isolated", async () => {
    const { actuator } = makeActuator([
      { createdAt: 1, id: "i-1", state: "ready" },
    ]);
    const errors: unknown[] = [];
    const scaler = createAutoscaler({
      actuator,
      audit: {
        append: () => {
          throw new Error("broker down");
        },
      },
      onError: (e) => errors.push(e),
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("hot", 0.95)],
    });
    await scaler.step();
    expect(errors).toHaveLength(1);
    expect(scaler.metrics().errors).toBe(1);
  });

  test("metrics track evaluations + scaleUps + scaleDowns + holds", async () => {
    const wrapped = makeActuator([
      { createdAt: 1, id: "i-1", state: "ready" },
      { createdAt: 2, id: "i-2", state: "ready" },
    ]);
    let score = 0.95;
    const scaler = createAutoscaler({
      actuator: wrapped.actuator,
      clock: (() => {
        let n = 1_000_000;
        return () => {
          n += 120_000;
          return n;
        };
      })(),
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { cooldownMs: 30_000, threshold: 0.3 },
        scaleUp: { cooldownMs: 30_000, threshold: 0.7 },
      }),
      signals: [{ name: "s", read: () => ({ score }) }],
    });
    await scaler.step();
    score = 0.05;
    await scaler.step();
    score = 0.5;
    await scaler.step();
    const m = scaler.metrics();
    expect(m.evaluations).toBe(3);
    expect(m.scaleUps).toBeGreaterThanOrEqual(1);
    expect(m.scaleDowns).toBeGreaterThanOrEqual(1);
    expect(m.holds).toBeGreaterThanOrEqual(1);
  });

  test("onDecision is called with the resulting decision", async () => {
    const seen: string[] = [];
    const { actuator } = makeActuator([
      { createdAt: 1, id: "i-1", state: "ready" },
    ]);
    const scaler = createAutoscaler({
      actuator,
      onDecision: (d) => seen.push(d.action),
      policy: createPolicy({
        max: 5,
        min: 1,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("hot", 0.95)],
    });
    await scaler.step();
    expect(seen).toEqual(["scale-up"]);
  });
});

// =============================================================================
// start / stop lifecycle
// =============================================================================

describe("lifecycle", () => {
  test("start sets running, stop clears it", () => {
    const { actuator } = makeActuator();
    const scaler = createAutoscaler({
      actuator,
      intervalMs: 1_000_000, // long — we'll never tick
      policy: createPolicy({
        max: 5,
        min: 0,
        scaleDown: { threshold: 0.3 },
        scaleUp: { threshold: 0.7 },
      }),
      signals: [constSignal("s", 0.5)],
    });
    expect(scaler.running()).toBe(false);
    scaler.start();
    expect(scaler.running()).toBe(true);
    scaler.start(); // idempotent
    expect(scaler.running()).toBe(true);
    scaler.stop();
    expect(scaler.running()).toBe(false);
  });
});
