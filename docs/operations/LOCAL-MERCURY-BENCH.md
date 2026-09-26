# LOCAL-MERCURY-BENCH — measured local model results for Mercury System 2

Evidence only. Every number below was produced on this machine on 2026-09-21 with the
patched `task/mercury-local-transport` code path (`BUDDY_MERCURY_BASE_URL` +
`BUDDY_MERCURY_LOCAL_NO_THINK=1`). No value is estimated.

> Superseded run notice: an earlier version of this file reported single runs per model
> whose fixture listed `iron_ore`/`coal_ore` as collectable. The code-owned matrix
> (`MERCURY_ALLOWED_GOALS`) rejects those names, so that fixture penalised every model
> with rejections it should never have seen. The table below uses the real matrix
> (`generation-entry.ts:664` passes `MERCURY_ALLOWED_GOALS` unchanged) and 3 runs per
> scenario per model.

## Hardware / runtime

- CPU: AMD Ryzen 7 9800X3D, RAM 30 GB
- GPU: AMD Radeon RX 7800 XT 16 GB (Vulkan, `RADV NAVI32`), no CUDA
- llama.cpp: stock `0.4.0-dev (build 10809)` for the Qwen GGUFs
- Ternary Bonsai 2 requires the PrismML fork binaries
  (`PrismML-Eng/llama.cpp` release `prism-b10709-9a9394a`, ubuntu-vulkan-x64)
- Server: `llama-server --host 127.0.0.1 --port 8081 -c 16384 --jinja`
  (Bonsai 2 was served with `-c 8192`)

## Test method

`MercurySystem2.tryRepair()` is driven directly against the local endpoint with the real
`SYSTEM_PROMPT`, `MERCURY_ALLOWED_GOALS`, `validateMercuryPlan`, the state-hash cache and
the corrective-retry loop (`retries: 2`). `resolveKey: () => null` proves the gateway key is
never consulted. Three scenarios x 3 runs per model, fresh cache/temp dir for every run:

- **simple**: stuck underground at y=12, no pickaxe
- **hard**: `action_impossible`, no fuel and no reachable placed furnace, `hasImpossible`
- **post_death**: died to lava, respawned at the surface with an empty inventory

`accepted` = `tryRepair()` returned a plan; `first_attempt_accepted` = no `PLAN_REJECTED`
was logged; `ms` = wall time of `tryRepair()` including retries.

## Results

| Model | File size | accepted | first attempt | median ms | max ms |
| --- | --- | --- | --- | --- | --- |
| Ternary Bonsai 2 27B PTQ1_0 (fork) | 5.93 GB | 9/9 | **9/9** | 14 604 | 18 892 |
| **Qwen3.5-9B UD-Q4_K_XL** (stock) | 5.97 GB | 9/9 | 6/9 | **1 390** | 3 118 |
| Qwen3.5-4B UD-Q4_K_XL (stock) | 2.91 GB | 9/9 | 6/9 | 1 384 | 2 106 |
| Qwen3.5-2B UD-Q4_K_XL (stock) | 1.34 GB | 9/9 | 4/9 | 896 | 1 081 |

### Plan quality (read from the emitted goal chains)

- Bonsai 2 27B, post_death: `collect log -> craft crafting_table -> place crafting_table ->
  collect raw_iron -> smelt iron_ingot` (complete and ordered).
- Qwen3.5-9B, post_death: `collect coal x8 -> craft furnace -> place furnace ->
  collect raw_iron -> smelt iron_ingot`; simple: `craft stone_pickaxe` (targets the real
  blocker); hard: `collect coal -> place furnace -> smelt iron_ingot`, accepted on attempt 2.
- Qwen3.5-4B, hard: `collect coal -> craft furnace -> place furnace -> smelt charcoal x64`
  — validation passes but `smelt charcoal x64` is not a sensible fuel step. simple:
  `craft wooden_pickaxe`. post_death: `collect raw_iron -> smelt iron_ingot`, i.e. the fuel
  and station steps are missing.
- Qwen3.5-2B, simple: `continue` with `collect cobblestone x1` / `collect raw_iron x1` —
  neither addresses the missing pickaxe. hard: `place furnace x1` only. post_death:
  `complete` with an empty goal list, which requests completion of an Option that has no
  work behind it.

### What matters for the choice

- Qwen3.5-9B and Qwen3.5-4B have **statistically identical latency** (median 1 390 ms vs
  1 384 ms). Prompt evaluation dominates the wall time, so the smaller model buys nothing
  here; the 9B plan semantics are clearly better.
- Qwen3.5-2B is the fastest but its plans are semantically wrong even though they pass the
  schema and capability validation, so validation alone cannot select it.
- Bonsai 2 27B is the only model that produced correct plans on the first attempt in every
  run, at roughly 10x the latency — acceptable for an exception-only planner, but it needs
  the PrismML fork binaries.

## Recommendation

Default **Qwen3.5-9B** (best quality/latency balance, stock llama.cpp). Use Bonsai 2 27B
when first-attempt plan quality matters more than latency (and the fork binaries are
available). 4B adds no speed; 2B should not be selected for Mercury.

```bash
# server
llama-server -m /data/models/Qwen3.5-9B-UD-Q4_K_XL.gguf \
  --host 127.0.0.1 --port 8081 -c 16384 --jinja

# resident
BUDDY_MERCURY_BASE_URL=http://127.0.0.1:8081/v1 \
BUDDY_MERCURY_MODEL=qwen3.5-9b-local \
BUDDY_MERCURY_LOCAL_NO_THINK=1 \
BUDDY_SYSTEM2_TIMEOUT_MS=240000 \
BUDDY_POLICY=fallback BUDDY_PLANNER=local-mercury BUDDY_SYSTEM2=mercury \
bun packages/buddy-driver/agent-runner.mts
```

## Ready-to-run setup (9B)

Two repo files carry the setup so it survives on another machine:

- `ops/deploy/mercury-local-9b.service` — systemd **user** unit that serves
  `/data/models/Qwen3.5-9B-UD-Q4_K_XL.gguf` as alias `qwen3.5-9b-local` on
  `127.0.0.1:8081` (`--ctx-size 16384 --jinja --temp 0`, `Restart=on-failure`).
  Install with
  `cp ops/deploy/mercury-local-9b.service ~/.config/systemd/user/ && systemctl --user daemon-reload`.
  Start it only when needed with `systemctl --user start mercury-local-9b`; leave the unit disabled so login does not auto-start it.
- `tools/mercury-local-preflight.mjs` — proves the endpoint is usable:
  `GET /models` lists the alias, then one `POST /chat/completions` with
  `chat_template_kwargs { enable_thinking: false }` returns a JSON object. Non-zero
  exit means "do not start the resident against this endpoint".
- `tools/start-local-mercury.sh` — starts the unit if the endpoint is down, runs the
  preflight, then execs the resident with
  `BUDDY_MERCURY_BASE_URL` / `BUDDY_MERCURY_MODEL` / `BUDDY_MERCURY_LOCAL_NO_THINK=1` /
  `BUDDY_SYSTEM2_TIMEOUT_MS=240000` / `BUDDY_POLICY=fallback` /
  `BUDDY_PLANNER=local-mercury` / `BUDDY_SYSTEM2=mercury`. Normal System2 decisions use the deterministic floor; exception repair (`no_progress`, impossible action, repeated WAIT) uses the local Mercury model without a TypeSafe Gateway key.

Measured on this machine after installing the unit:

```
systemctl --user is-active mercury-local-9b  -> active
GET  /models                                 -> ["qwen3.5-9b-local"]
POST /chat/completions (preflight)           -> 312 ms, {"op":"patch","goals":[],"reason":"preflight"}
3-scenario smoke via MercurySystem2          -> accepted 3/3, first attempt 2/3, median 1 694 ms, max 2 940 ms
```

Switching the live resident to it requires stopping the current process first: the host
guard (`packages/buddy-driver/data/resident/host.lock`) is single-instance, so two residents cannot
coexist, and the patch lives on a branch until it is merged into `main`.


- Three synthetic states, three runs each, no full resident run. A replay A/B against the
  gateway Mercury (issue #23) is still required before this counts as an acceptance result.
- Latency was measured with an otherwise idle GPU; concurrent Minecraft load was not isolated.
- Reasoning must stay disabled. With the default `reasoning_effort=xhigh` the model spent the
  whole output budget on hidden thinking (`finish_reason=length`, empty content); the same
  state succeeded in 20 s once `enable_thinking:false` was sent.
