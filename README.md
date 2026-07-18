# `@absolutejs/autoscaler`

> Horizontal-scaling policy substrate for the AbsoluteJS PaaS.

`@absolutejs/autoscaler` owns the **decision** half of an
autoscaler. The actuator half — actually provisioning a VM,
draining a pod, killing a process — lives in your control plane
via an injected `Actuator`, so the substrate stays cloud-agnostic
and runtime-agnostic.

The same substrate fits:

- a 10-VM fleet across DigitalOcean / Hetzner / Linode
- a 10000-isolate fleet on one box via `@absolutejs/isolated-jsc`
- a pod-per-tenant cluster on Kubernetes

The actuator defines what "instance" means.

## Loop

```
read signals  →  combine into a score  →  compare to thresholds  →
if past threshold & cooldown elapsed  →  ask actuator to spawn/drain
                                          (clamped to min/max)
```

## API

```ts
import {
  createAutoscaler,
  createPolicy,
  ratioSignal,
} from "@absolutejs/autoscaler";

const scaler = createAutoscaler({
  policy: createPolicy({
    min: 1,
    max: 20,
    scaleUp: { threshold: 0.75, cooldownMs: 60_000, step: 1 },
    scaleDown: { threshold: 0.3, cooldownMs: 300_000, step: 1 },
  }),
  signals: [
    ratioSignal("cpu", 0.8, async () => await meter.cpuUtilization()),
    ratioSignal("queue", 100, async () => await queue.depth(), {
      observedKey: "depth",
    }),
    ratioSignal("latencyP95", 200, async () => await metrics.p95()),
  ],
  combine: "max", // worst pressure wins. or 'avg', or a custom fn
  actuator: {
    list: () => fleet.list(),
    spawn: () => fleet.provision(),
    drain: (id) => loadBalancer.remove(id),
    terminate: (id) => fleet.destroy(id),
  },
  audit: broker, // optional; emits autoscaler.scale.up etc.
  intervalMs: 30_000,
});

scaler.start();
// fires every 30s

const reviewedPlan = await scaler.evaluate();
await scaler.applyDecision(reviewedPlan, { maxAgeMs: 300_000 });
// applies that exact plan only while its capacity precondition still holds

const oneShot = await scaler.step();
// { action: 'scale-up' | 'scale-down' | 'hold', score, currentCount,
//   desiredCount, reason, readings: [...], at }
```

## Signals

A `Signal` is `{ name, read: () => SignalReading | Promise<SignalReading> }`.

A `SignalReading` is `{ score, observed? }`. `score` is normalized:
`1.0` = "at the scale-up target." Going past 1.0 represents over-
target pressure.

The bundled `ratioSignal(name, target, read)` helper builds the
canonical "observed / target" shape for CPU utilization, memory
pressure, queue depth, latency, etc.

A signal that throws is captured as `{ failed: true, error }` in
the decision readings and excluded from the combined score. The
loop never breaks because one metric source is offline.

## Combine strategies

- **`'max'`** (default) — worst pressure wins. The safe choice for
  elasticity: any one over-stressed dimension scales the fleet.
- **`'avg'`** — weighted mean using each signal's `weight`. Zero-
  weight signals are ignored.
- **Custom function** — `(readings) => number` for arbitrary
  composition (latency-weighted CPU, percentile-of-percentile, …).

## Cooldowns

`scaleUp` and `scaleDown` have **independent** cooldown timers — a
fleet that just scaled up can still scale down moments later if the
load drops. Default `cooldownMs` is 60 seconds.

## Audit trail

When an `audit` broker is supplied, every applied decision emits:

- `autoscaler.scale.up` — with `{ score, currentCount, desiredCount, reason }`
- `autoscaler.scale.down`
- `autoscaler.hold`

All three are emitted (even `hold`) so the audit trail tells the
full story of why the fleet is where it is. Broker failures are
isolated; they bump the `metrics().errors` counter but never break
the loop.

## License

BSL-1.1 with named carveout against hosted autoscaling /
elasticity SaaS (Karpenter SaaS offerings, Spot.io, CAST AI,
PerfectScale, Densify, Granulate). See `LICENSE`. Change date:
**2030-05-31** → Apache 2.0.
