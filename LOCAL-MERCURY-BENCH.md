# LOCAL-MERCURY-BENCH — measured local model results for Mercury System 2

Evidence only. Every number below was produced on this machine on 2026-09-21 with the
patched `task/mercury-local-transport` code path (`BUDDY_MERCURY_BASE_URL` +
`BUDDY_MERCURY_LOCAL_NO_THINK=1`). No value is estimated.

## Hardware / runtime

- CPU: AMD Ryzen 7 9800X3D, RAM 30 GB
- GPU: AMD Radeon RX 7800 XT 16 GB (Vulkan, `RADV NAVI32`), no CUDA
- llama.cpp: stock `0.4.0-dev (build 10809)` for the Qwen GGUFs
- Ternary Bonsai 2 requires the PrismML fork binaries
  (`PrismML-Eng/llama.cpp` release `prism-b10709-9a9394a`, ubuntu-vulkan-x64)
- Server: `llama-server --host 127.0.0.1 --port 8081 -c 16384 --jinja`

## Test method

`MercurySystem2.tryRepair()` is driven directly against the local endpoint with the real
`SYSTEM_PROMPT`, the real `validateMercuryPlan` grounding/capability validation, the real
state-hash cache and the real corrective-retry loop. `resolveKey: () => null` proves the
gateway key is never consulted. Two scenario states:

- **simple**: stuck underground at y=12, no pickaxe, allowedGoals = stone/coal_ore/iron_ore/log
  collect, stone_pickaxe/crafting_table/furnace/stick craft, charcoal/iron_ingot smelt
- **hard**: `action_impossible`, missing fuel and no reachable placed furnace,
  goal queue empty, allowedGoals unchanged

`elapsed` is the wall time of `tryRepair()` (includes every attempt and the cache write).

## Results

| Model | File size | simple | hard | Verdict |
| --- | --- | --- | --- | --- |
| Ternary Bonsai 2 27B PTQ1_0 (fork) | 5.93 GB | 14 046 ms, accepted attempt 1 (`patch collect stone`) | 27 260 ms, 1 rejection then accepted (`patch collect coal`) | viable, slow, fork-only |
| Qwen3.5-9B UD-Q4_K_XL (stock) | 5.97 GB | 1 622 ms, accepted attempt 1 (`replace craft stone_pickaxe`) | 3 346 ms, 1 rejection then accepted (`replace collect coal`) | **best balance** |
| Qwen3.5-9B with thinking enabled | 5.97 GB | — | 22 289 ms, 1 rejection then accepted | thinking costs ~7x with no quality gain |
| Qwen3.5-4B UD-Q4_K_XL (stock) | 2.91 GB | 1 976 ms, 1 rejection then accepted (`replace collect raw_iron`) | 920 ms, accepted attempt 1 (`replace goto_resource coal_ore`) | fastest usable |
| Qwen3.5-2B UD-Q4_K_XL (stock) | 1.34 GB | **FATAL `MODEL_UNAVAILABLE`** after 2 attempts (`collect iron_ore`, then `collect coal_ore` after corrective feedback) | 377 ms, accepted attempt 1 (`patch place furnace`) | not reliable (1 of 2 scenarios fatal) |

## What the failures prove

- The grounding guard is model-independent: every model that emitted an item outside
  `allowedGoals` (`iron_ore`, `coal_ore`) was rejected locally with `PLAN_REJECTED`
  before any plan reached the goal queue.
- The corrective retry works when the model can use the feedback: Bonsai 2 27B, Qwen3.5-9B
  and Qwen3.5-4B all recovered on attempt 2.
- Qwen3.5-2B ignored the corrective feedback twice, which exhausted `maxAttempts` and
  produced `FATAL code=MODEL_UNAVAILABLE` — in the resident that terminates the process by
  design, so 2B must not be selected for Mercury.
- Reasoning must be disabled (`BUDDY_MERCURY_LOCAL_NO_THINK=1`). With the default
  `reasoning_effort=xhigh` the model spent the whole output budget on hidden thinking
  (`finish_reason=length`, empty content); the same state then succeeded in 20 s once
  `enable_thinking:false` was sent.

## Recommended configuration

```bash
# start the server (one model at a time: 16 GB VRAM fits ~2 x 6 GB but leaves <2 GB free)
llama-server -m /data/models/Qwen3.5-9B-UD-Q4_K_XL.gguf \
  --host 127.0.0.1 --port 8081 -c 16384 --jinja

# resident
BUDDY_MERCURY_BASE_URL=http://127.0.0.1:8081/v1 \
BUDDY_MERCURY_MODEL=qwen3.5-9b-local \
BUDDY_MERCURY_LOCAL_NO_THINK=1 \
BUDDY_SYSTEM2_TIMEOUT_MS=240000 \
BUDDY_PLANNER=llm BUDDY_SYSTEM2=mercury \
bun buddy-driver/agent-runner.mts
```

## Limits of this evidence

- Two synthetic states, one run each, no repetition and no full resident run.
  A replay A/B against the gateway Mercury (issue #23) is still required before this
  counts as an acceptance result.
- Latency is measured with idle GPU; concurrent Minecraft server load was not isolated.
