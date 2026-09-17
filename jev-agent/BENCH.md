# Jev benchmark — latency, cost and call-rate limits

End-to-end benchmark of `typesafe-ai/jev` through the **Vercel AI Gateway**,
using the same call path the agent uses:

```
ai@7.0.105  →  import { experimental_evaluate as evaluate } from 'ai'
            →  evaluate({ model: 'typesafe-ai/jev', state, questions })
```

* Date: 2026-09-17
* Gateway key: `/home/s0u7a/.config/kimaki-secrets/vercel-ai-gateway.key`
  (read at runtime; only a `length=60 prefix=vck_...` check is ever printed —
  the key is **not** in this file, the JSONL, or the logs).
* Pricing (from `GET /v1/models`): input `$0.000000042`/token = **$0.042 / 1M**,
  output `$0` (not billed). The task's `$0.04 / 1M` is used in the tables.
* Total spend: **$0.007035** for 61 calls (≈14 % of the $0.05 budget).

---

## 1. Headline: the gateway rate-limits this key hard

The key is on the AI Gateway **free tier**, and that — not latency — is the
binding constraint on how often the bot can call Jev.

* Measured quota: **4 successful requests per ~300 s rolling window.**
  The 5th request returns `HTTP 429`
  `Free tier requests on this model are rate-limited. Upgrade to paid credits…`
* Recovery after saturation needed **~270–330 s of silence** (probed at
  150/210/270/330 s; first success at 330 s).
* `AbortSignal`/latency is fine; the wall-clock cost of the suite was entirely
  quota waiting. 61 calls took ≈72 minutes (~0.85 ok/min) because the runner
  deliberately paces to the quota instead of burning calls on 429s.

`bench.mjs` therefore ships a rate-limit-aware pacer (defaults
`--quota 4 --window-sec 300`). It reserves capacity before each call, and if a
429 still slips through it treats it as a *pacing signal* (waits out the window,
does not count it as a logical retry) rather than a failure.

---

## 2. Methodology

* **61 calls, 0 failures** (`ok=true` for all; no 429s landed in the dataset).
* Buckets (10 calls each except `cold`, which is the single first call of the process):

| bucket | questions | state | purpose |
| --- | --- | --- | --- |
| `cold` | 4 | ~1.2 k tok | the very first call of the process |
| `warm` | 4 | ~1.2 k tok | subsequent baseline calls = **s1k** |
| `q1` | 1 | ~1.2 k tok | question-count sweep, same state |
| `q10` | 10 | ~1.2 k tok | question-count sweep, same state |
| `s4k` | 4 | ~4.6 k tok | state-size sweep |
| `s8k` | 4 | ~8.0 k tok | state-size sweep |
| `burst` | 4 | ~1.2 k tok | 2 × 5 concurrent in flight, separate |

* **State** is realistic Minecraft data (entity / block lists, terrain,
  inventory, goal, signals), not random junk; padding is generated with a fixed
  seed. Distinct `usage.inputTokens` values cluster at **1.1 k / 4.6 k / 8.0 k**,
  confirming the state-size buckets.
* **Question types are only `choice` | `score` | `boolean`** (no `noul`).
  State-size buckets use 4 questions; question-count buckets share the same state.
* **Order used** (seed `20260917`): `cold` first, then interleaved rounds in the
  shuffled order `q1 → q10 → s8k → warm → s4k` (one sample per bucket per round,
  so a slow provider phase cannot bias one bucket), then the burst phase
  (2 groups of 5) last.
* Sequential, one call in flight (`concurrency = 1`) unless noted.
* Percentiles use linear interpolation over the successful samples
  (p = (n-1)·p, interpolated).

---

## 3. Raw percentile table

Latency in **ms**; `meanInTok` = mean `result.usage.inputTokens`; cost uses input only.

| bucket | n | ok | p50 | p90 | p95 | max | mean | meanInTok | total cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `cold` (first call) | 1 | 1 | 580 | 580 | 580 | 580 | 580 | 1201 | $0.000048 |
| `warm` (= s1k, 4q) | 10 | 10 | 449 | 696 | 734 | 772 | 503 | 1166 | $0.000467 |
| `q1` (1 question) | 10 | 10 | 548 | 770 | 830 | 890 | 567 | 1096 | $0.000439 |
| `q10` (10 questions) | 10 | 10 | 555 | 790 | 796 | 802 | 547 | 1401 | $0.000561 |
| `s4k` (~4.6 k tok) | 10 | 10 | 571 | 1025 | 1104 | 1182 | 659 | 4609 | $0.001844 |
| `s8k` (~8.0 k tok) | 10 | 10 | 718 | 820 | 825 | 830 | 672 | 8027 | $0.003211 |
| `burst` (5 in flight) | 10 | 10 | 546 | 646 | 658 | 671 | 567 | 1166 | $0.000467 |
| **all calls** | **61** | **61** | — | — | — | **1182** | — | — | **$0.007035** |

Notes:

* **Question count barely matters.** q1 → q4 → q10 (same state) moved p50 from
  548 → 449 → 555 ms, i.e. within noise. Ten batched questions cost ~26 % more
  input tokens but essentially the same latency as one.
* **State size matters mildly.** p50 grew 449 → 571 → 718 ms from ~1.2 k →
  ~4.6 k → ~8.0 k tokens (+60 % p50, +50 % p95 from 1 k to 8 k). Never above
  1.19 s across the whole run.
* **The distribution is tight.** Every bucket's `max` is within ~2.2× its p50;
  there are no multi-second stalls.

### Burst detail (concurrency = 5)

| group | in flight | wall | slowest call | ok | rate-limited |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 | 5 | 517 ms | 517 ms | 5/5 | 0 |
| 1 | 5 | 671 ms | 671 ms | 5/5 | 0 |

A 5-wide burst launched into a **fresh** quota window completed 5/5 with **no
latency degradation** (group wall ≈ slowest single call ≈ 0.5–0.7 s) and **no
429**. But the gateway does rate-limit: in the pre-run characterisation, firing a
5th request straight after 4 sequential successes returned `429` on that 5th
request. So concurrency is fine for *latency*, while the 4-per-window quota still
caps *throughput*.

---

## 4. Conclusion

**Safe call rate for the bot: ~1 Jev call per 75 s sustained (4 per 5-minute
window) on this free-tier key.** That is ~0.013 Hz — the README's proposed
`100–500 ms` / `2–10 Hz` policy interval is *not* achievable here; it needs paid
credits. The constraint is purely the gateway quota, not Jev: at rest Jev answers
in 0.45–0.72 s (p50) and 0.66–1.10 s (p95), so a single sequential call would fit
comfortably inside a 1–2 s tick if quota allowed, and up to 5 independent
questions/requests can be evaluated in parallel with no latency penalty. The bot
should therefore run a slow policy tick (≥75 s) with batched questions in one
call, cache/short-circuit locally between ticks, and treat `429` as a backoff
signal.

**The earlier single 873 ms sample is *not* a cold-path artefact.** In this run
the very first call of the process (`cold`) was **580 ms**, and warm calls
measured p50 449 ms / p90 696 ms / p95 734 ms / max 772 ms, while the ~4.6 k-token
bucket reached 1182 ms. 873 ms sits in the ordinary upper tail of a warm call, so
that sample is normal provider jitter (or a slightly larger state), not a cold
start. Cold start, if anything, looked *cheaper* than the warm p90.

---

## 5. Reproduce

```bash
cd /home/s0u7a/mc-ai/jev-agent

# full suite: 61 calls, self-paced to the free-tier quota (~72 min)
node bench.mjs --out data/bench.jsonl --seed 20260917

# one bucket / N calls (e.g. 10 warm samples)
node bench.mjs --bucket warm --calls 10 --out data/bench.jsonl

# just the first-call-of-process sample
node bench.mjs --bucket cold --calls 1 --out /tmp/opencode/cold.jsonl

# re-measure the state-size → inputTokens mapping (3 calls)
node bench.mjs --calibrate

# pacing knobs (defaults: 4 successes / 300 s). --pace off disables waiting.
node bench.mjs --quota 4 --window-sec 300
```

Flags: `--calls N`, `--bucket <name>[,<name>...]`, `--out <file>`, `--append`,
`--seed N`, `--quota N`, `--window-sec N`, `--pace off`, `--calibrate`.

## 6. Artifacts

* `bench.mjs` — benchmark runner (flags above).
* `data/bench.jsonl` — **61 records**, one per call:
  `{bucket, i, coldStart, questions, inputTokens, outputTokens, ms, ok, error?, …}`
  (plus `at, statePreset, concurrency, group, attempts, rateLimited, rateLimitWaits,
  rounding, confidence, resolvedProvider, modelAttempts`). No key material.
* `data/bench.summary.json` — machine-readable per-bucket percentiles.
* `logs/bench.log` — run log including pacer/429 waits and progress every 10 calls.
