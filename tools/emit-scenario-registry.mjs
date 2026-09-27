#!/usr/bin/env bun
// Regenerate docs/development/SCENARIO-REGISTRY.json from the typed scenario
// definitions in packages/kernel/scenarios.ts plus pointer rows that index
// existing deterministic regression files. Run: bun tools/emit-scenario-registry.mjs

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KERNEL_SCENARIOS } from '../packages/kernel/scenarios.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stableJson(v)]))
  return value
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

// Pointer rows index deterministic regression files that already encode real
// historical failures on non-kernel surfaces. The lab runner treats each row
// as a scenario whose command is the referenced test.
const POINTER_SCENARIOS = [
  {
    id: 'sc-r-threat-grounding',
    surface: 'packages/jev-agent',
    origin: 'docs/history/incidents/NETHER-SURVIVAL-2026-09-22.md — threat contact with wrong gear and ungrounded response (94% of Nether expeditions lost the body)',
    hypothesis: 'a contact threat must produce a grounded survival response, not ungrounded candidate churn',
    command: 'bun test packages/jev-agent/test-threat-response-grounding.mts',
    files: ['packages/jev-agent/test-threat-response-grounding.mts'],
  },
  {
    id: 'sc-r-move-stuck-stale',
    surface: 'packages/jev-agent',
    origin: 'docs/history/incidents/BUDDY-DEFECTS.md defect A — no-progress motion loop dominated the queue while nothing verified',
    hypothesis: 'stuck/stale movement must terminalize as a typed failure instead of wedging the queue',
    command: 'bun test packages/jev-agent/test-move-stuck-stale.mts',
    files: ['packages/jev-agent/test-move-stuck-stale.mts'],
  },
  {
    id: 'sc-r-dig-ground-truth',
    surface: 'packages/jev-agent',
    origin: 'docs/history/incidents/BUDDY-DEFECTS.md defects B/C — dig interrupted before block broke; wrong tool for the resource class',
    hypothesis: 'dig completion and tool choice are bound to ground truth, not candidate claims',
    command: 'bun test packages/jev-agent/test-dig-ground-truth.mts',
    files: ['packages/jev-agent/test-dig-ground-truth.mts'],
  },
  {
    id: 'sc-r-stale-drop-cells',
    surface: 'packages/buddy-driver',
    origin: 'live regression — remembered drop/resource cells went stale and drove approaches to dead locations',
    hypothesis: 'stale remembered cells are fenced before they can ground an approach',
    command: 'bun test packages/buddy-driver/test-stale-drop-cells.mts',
    files: ['packages/buddy-driver/test-stale-drop-cells.mts'],
  },
  {
    id: 'sc-r-double-authority',
    surface: 'packages/jev-agent',
    origin: 'migration invariant — legacy Executor claim must never overlap VTR body authority',
    hypothesis: 'the legacy claim path refuses while a VTR transition owns the body',
    command: 'bun test packages/jev-agent/test-vtr-reach-executor-dispatch-authority.mts',
    files: ['packages/jev-agent/test-vtr-reach-executor-dispatch-authority.mts'],
  },
  {
    id: 'sc-r-reach-mission-authority',
    surface: 'packages/jev-agent',
    origin: 'P1 boundary pin — legacy Reach locomotion to a mission source is withheld while VTR owns the mission',
    hypothesis: 'the strangler withholds same-predicate locomotion and nothing else',
    command: 'bun test packages/jev-agent/test-vtr-reach-mission-authority.mts',
    files: ['packages/jev-agent/test-vtr-reach-mission-authority.mts'],
  },
]

const rows = KERNEL_SCENARIOS.map((def) => ({
  id: def.id,
  kind: 'kernelTrace',
  surface: 'packages/kernel',
  origin: def.origin,
  hypothesis: def.hypothesis,
  defSha256: sha256(JSON.stringify(stableJson(def))),
  expect: def.expect,
}))
const pointerRows = POINTER_SCENARIOS.map((row) => ({
  ...row,
  kind: 'regression',
  defSha256: sha256(JSON.stringify(stableJson(row))),
}))

const registry = {
  schema: 'vtr-scenario-registry/v1',
  generatedFrom: ['packages/kernel/scenarios.ts', 'tools/emit-scenario-registry.mjs'],
  definitionsSha256: sha256(readFileSync(join(root, 'packages/kernel/scenarios.ts'))),
  scenarios: [...rows, ...pointerRows],
}
const out = join(root, 'docs/development/SCENARIO-REGISTRY.json')
writeFileSync(out, `${JSON.stringify(registry, null, 2)}\n`)
console.log(`wrote ${out}: ${rows.length} kernel traces, ${pointerRows.length} regression pointers`)
