# @absolutejs/autoscaler changelog

## 0.1.0 — 2026-05-31

Initial release. **Closes G15 — the final gap from the second-pass
PaaS audit.** The substrate now has a horizontal-scaling decision
loop on top of metering / cluster-bus / deploy primitives.

### Added

- **`createAutoscaler({ policy, signals, actuator, ... })`** —
  pluggable decision engine. Periodically reads signals, combines
  them into a score, compares against scale-up / scale-down
  thresholds, asks the actuator to spawn / drain / terminate
  within `min` / `max`.
- **`createPolicy({ min, max, scaleUp, scaleDown })`** — validates
  shape at construction. Rejects overlapping thresholds (would
  cause flapping), non-integer min/max, negative min, max < min,
  and non-positive scale-up threshold.
- **`ratioSignal(name, target, read)`** — canonical
  "observed / target" signal helper for CPU, memory, queue depth,
  latency.
- **Three combine strategies**: `'max'` (worst-pressure wins,
  default — the safe choice for elasticity), `'avg'` (weighted
  mean, zero-weight rows ignored), or a custom function.
- **Independent cooldowns** for scale-up and scale-down so a fleet
  that just scaled up can still scale down if the load drops
  moments later.
- **Audit trail** — when an `audit` broker is provided, emits
  `'autoscaler.scale.up'` / `'autoscaler.scale.down'` /
  `'autoscaler.hold'` on every applied decision. `hold` is included
  so the audit log tells the full story.
- **Per-signal failure isolation** — a throwing signal becomes
  `{ failed: true, error }` in the decision readings; the loop
  continues with the surviving signals.
- **Per-actuator failure isolation** — spawn / drain / terminate
  errors bump `metrics().errors` and call `onError` but never break
  the loop.
- **`metrics()`** surface — `evaluations`, `scaleUps`, `scaleDowns`,
  `holds`, `errors`, `lastScore`, `lastAction`, `lastAt`.
- **`evaluate()`** — read signals + compute the decision WITHOUT
  mutating the fleet. Useful for dashboards and dry-run inspection.
- **Newest-first drain** during scale-down — warmed instances live
  longer, cold-started instances die first.

### Design notes

- The substrate owns DECISION logic. The ACTUATOR — provisioning
  hardware, draining a load balancer, killing a process — is
  injected. The same `createAutoscaler` fits a 10-VM cloud fleet,
  a 10000-isolate fleet on one box (`@absolutejs/isolated-jsc`),
  and a pod-per-tenant K8s cluster.
- Hard threshold gap between `scaleUp` and `scaleDown` is enforced
  at policy construction to prevent flapping. There's no "deadband"
  knob because the gap between thresholds IS the deadband.
- `pending` and `ready` instances both count toward capacity;
  `draining` and `terminated` do not.

### Tests

34 covering: policy validation (min/max bounds, threshold ordering,
flapping prevention); `ratioSignal` (basic ratio, zero-target,
custom observedKey, weight propagation); `evaluate` (scale-up,
scale-down, hold, at-max, at-min, pending counts toward capacity,
signal failure isolation, no-signals zero-score); combine
strategies (`'max'`, `'avg'` weighting, `'avg'` zero-weight
ignore, custom function); `step` (spawn count, scale-up clamp to
max, drain newest-first, spawn failure isolation); cooldowns
(scale-up cooldown, scale-down cooldown, independent timers);
audit (per-action emission, hold emission, broker failure
isolation); metrics (evaluations / scaleUps / scaleDowns / holds
counts, onDecision callback); lifecycle (start / stop / running
idempotency).

### License

BSL-1.1 with named carveout against hosted autoscaling / elasticity
SaaS (Spot.io, CAST AI, PerfectScale, Densify, Granulate). Change
date: 2030-05-31 (Apache 2.0).
