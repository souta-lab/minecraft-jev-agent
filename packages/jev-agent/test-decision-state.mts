// test-decision-state.mts - JEV-BEST-PRACTICES §18 Gate B: the canonical
// compact DecisionState.
//
// The p24 audit (tools/jev-state-audit.mjs) proved the defect: the recorded
// model-facing payload carried the semantic projection AND a duplicated raw
// outer block - mean state 15,467 bytes of which ~11KB were self/signals/
// nearest*/outer-candidates copies of facts already in `semantic`, and
// 2,306/2,477 consecutive same-signature calls still hashed differently.
//
// Gate B contract under test:
//   1. the versioned semantic projection IS the whole model-facing state -
//      exactly one representation of each semantic fact, no outer duplicates;
//   2. the compiler is deterministic and mechanical churn cannot change the
//      hash (realization ids, tick, raw event spellings);
//   3. every fact a head consumes is present once: Option contract in
//      `option`, the #360 recurrence block in `progress.stall`, the queue head
//      in `queue`, banded body/threat facts in `safety`/`combat`;
//   4. the evidence-only `counts` block never reaches the model;
//   5. semantic changes still change the hash;
//   6. unprojected callers (VTR route frames, legacy fixtures) keep the raw
//      shape.
import assert from 'node:assert/strict'
import { authorityState } from './src/jev/authority.ts'
import {
  buildJevSemanticProjection,
  projectionHash,
  projectionModelView,
} from './src/jev/semantic-projection.ts'
import type {
  JevSemanticProjection,
  SemanticProjectionInput,
} from './src/jev/semantic-projection.ts'
import type { Candidate } from './src/candidates.ts'

const OVERWORLD = 'minecraft:overworld'

function candidate(input: Partial<Candidate> & { id: string; kind: Candidate['kind'] }): Candidate {
  return {
    targetName: null,
    target: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    label: input.id,
    meta: {},
    ...input,
  } as Candidate
}

function projectionInput(overrides: Partial<SemanticProjectionInput> = {}): SemanticProjectionInput {
  return {
    goal: { key: 'collect:obsidian:10', targetItem: 'obsidian', have: 0, required: 10, complete: false, progress: 0 },
    option: {
      instanceId: 'option:collect_obsidian#1',
      templateId: 'collect:obsidian',
      semanticInstanceId: 'option:collect_obsidian#1',
      semanticTemplateId: 'collect:obsidian',
      intent: 'collect 10 obsidian',
      skillKind: 'MINE',
      targetKey: 'obsidian',
      preconditions: ['pickaxe rank >= 4'],
      success: ['obsidian >= 10'],
      allowedSkills: ['MINE', 'MOVE', 'WAIT'],
      verifiedProgress: 3,
      failures: 1,
    },
    world: { dimension: OVERWORLD, worldEpoch: 3, generationId: 'gen-test', leaseHeld: true, alive: true },
    safety: {
      healthBand: 'healthy', foodBand: 'full', airBand: 'full', dayPhase: 'day', submerged: false,
      threatKey: null, criticalDamageKey: null, lastDamageKey: null, wornArmor: null, offhand: null,
    },
    progress: {
      consecutiveFailures: 1,
      lastFailureCode: 'path_timeout',
      escalationRecommended: false,
      oscillationsDetected: 0,
      stall: {
        windowSize: 24, distinctStates: 3, bodyDecisions: 24, semanticDecisions: 0,
        horizon: 24, maxDistinctStates: 4, exhausted: true, exhaustedRepeats: 1,
      },
    },
    queue: {
      depth: 2,
      empty: false,
      hasImpossible: false,
      current: {
        id: 'g1:obsidian',
        description: 'collect 10 obsidian for the portal frame',
        optionInstanceId: 'option:collect_obsidian#1',
        semanticOptionInstanceId: 'option:collect_obsidian#1',
      },
    },
    inventory: { cobblestone: 37, diamond_pickaxe: 1 },
    events: ['failure path_timeout: MOVE:p1_2_3', 'failure path_timeout: MOVE:p9_9_9', 'dug stone'],
    candidates: [
      candidate({ id: 'MINE:b10_20_30', kind: 'MINE', label: 'mine obsidian at (10,20,30)', targetName: 'obsidian', inReach: true }),
      candidate({ id: 'WAIT', kind: 'WAIT' }),
    ],
    identityContext: { optionInstanceId: 'option:collect_obsidian#1', dimension: OVERWORLD, worldEpoch: 3 },
    ...overrides,
  }
}

/** Minimal request: the projection path needs only these JevRequest fields. */
function projectedRequest(projection: JevSemanticProjection, candidates: Candidate[]): unknown {
  return {
    stage: 'decision-state-test',
    candidates,
    questionNames: ['action', 'abandon_option'],
    semanticProjection: projection,
    projectionHash: projectionHash(projection),
    state: {
      tick: 99,
      timestampMs: 0,
      self: { position: { x: 1.5, y: 20, z: 2.5 }, health: 20, food: 20, dimension: OVERWORLD },
      inventory: { counts: { cobblestone: 37 } },
      entities: [],
      blocks: [],
      signals: {},
      goal: null,
      goalQueue: { depth: 2, empty: false, current: null },
      currentOption: null,
      recentOutcomes: [],
      recentEvents: [],
    },
  }
}

// --- 1. The projection IS the model-facing state: no outer duplicates. ---
const projection = buildJevSemanticProjection(projectionInput())
const request = projectedRequest(projection, [...projectionInput().candidates]) as never
const payload = authorityState(request)

const expectedKeys = [
  'schema', 'version', 'goal', 'option', 'world', 'safety', 'combat', 'progress',
  'queue', 'sense', 'events', 'inventory', 'inventoryTruncated', 'candidates',
  'previousDecision', 'meaningfulDelta', 'recentOutcomes', 'facts', 'projectionHash',
]
assert.deepEqual(Object.keys(payload).sort(), [...expectedKeys].sort())

// The duplicated outer blocks of the v6 payload are gone.
for (const dropped of [
  'self', 'signals', 'goalQueue', 'currentOption', 'nearestBlocks', 'nearestEntities',
  'recentEvents', 'tick', 'semantic', 'projectionVersion',
]) {
  assert.equal(payload[dropped], undefined, `dropped section leaked: ${dropped}`)
}

// --- 2. Every head-consumed fact is present exactly once. ---
const option = payload.option as Record<string, unknown>
assert.equal(option.intent, 'collect 10 obsidian')
assert.deepEqual(option.success, ['obsidian >= 10'])
assert.deepEqual(option.preconditions, ['pickaxe rank >= 4'])
assert.deepEqual(option.allowedSkills, ['MINE', 'MOVE', 'WAIT'])
assert.equal(option.verifiedProgress, 3)
assert.equal(option.failures, 1)
assert.equal(option.semanticInstanceId, 'option:collect_obsidian#1')

const progress = payload.progress as Record<string, unknown>
assert.deepEqual((progress.stall as Record<string, unknown>).exhausted, true)
assert.equal((progress.stall as Record<string, unknown>).distinctStates, 3)
assert.equal(progress.consecutiveFailures, 1)

const queue = payload.queue as Record<string, unknown>
assert.equal(queue.depth, 2)
assert.equal((queue.current as Record<string, unknown>).id, 'g1:obsidian')
assert.equal(
  (queue.current as Record<string, unknown>).optionSpec,
  undefined,
  'the raw optionSpec must never reach inference',
)

assert.equal(payload.schema, 'jev-semantic-projection/v9')
assert.equal(payload.version, 9)
assert.equal(typeof payload.projectionHash, 'string')
assert.match(payload.projectionHash as string, /^jp9:/)

// --- 3. Determinism: the compiler is a pure function. ---
const again = buildJevSemanticProjection(projectionInput())
assert.equal(JSON.stringify(projectionModelView(again)), JSON.stringify(projectionModelView(projection)))
assert.equal(projectionHash(again), projectionHash(projection))

// --- 4. Mechanical churn cannot change the hash. ---
//    (a) realization ids for the same semantic identity collapse;
const realized = buildJevSemanticProjection(
  projectionInput({
    candidates: [
      candidate({ id: 'MINE:b10_20_30_ALT', kind: 'MINE', label: 'mine obsidian at (10,20,30)', targetName: 'obsidian', inReach: true, target: { x: 10, y: 20, z: 30 } }),
      candidate({ id: 'WAIT', kind: 'WAIT' }),
    ],
  }),
)
// different realization id BUT different param identity too (cell key) - so compare
// two realizations of the SAME identity instead:
const deduped = buildJevSemanticProjection(
  projectionInput({
    candidates: [
      candidate({ id: 'MINE:b10_20_30', kind: 'MINE', label: 'mine obsidian at (10,20,30)', targetName: 'obsidian', inReach: true, target: { x: 10, y: 20, z: 30 } }),
      candidate({ id: 'MINE:b10_20_30_b', kind: 'MINE', label: 'mine obsidian at (10,20,30)', targetName: 'obsidian', inReach: true, target: { x: 10, y: 20, z: 30 } }),
      candidate({ id: 'WAIT', kind: 'WAIT' }),
    ],
  }),
)
// The second MINE is the same semantic identity -> merged into one view.
assert.equal(deduped.candidates.filter((view) => view.kind === 'MINE').length, 1)
assert.ok(deduped.counts.candidatesMerged >= 1)
void realized

//    (b) raw event spellings of the same kinds collapse.
const respelled = buildJevSemanticProjection(
  projectionInput({ events: ['failure path_timeout: MOVE:p4_4_4', 'failure path_timeout: MOVE:p5_5_5', 'dug gravel'] }),
)
const respelledTwice = buildJevSemanticProjection(
  projectionInput({ events: ['failure path_timeout: MOVE:p6_6_6', 'failure path_timeout: MOVE:p7_7_7', 'dug gravel'] }),
)
assert.deepEqual(respelled.events, respelledTwice.events, 'same failure KIND twice = one fact')

//    (c) counts telemetry never reaches the model view.
assert.equal((projectionModelView(projection) as Record<string, unknown>).counts, undefined)

// --- 5. Semantic changes DO change the hash. ---
assert.notEqual(
  projectionHash(buildJevSemanticProjection(projectionInput({ goal: { key: 'collect:obsidian:10', targetItem: 'obsidian', have: 10, required: 10, complete: true, progress: 1 } }))),
  projectionHash(projection),
  'goal completion is a semantic boundary',
)
assert.notEqual(
  projectionHash(
    buildJevSemanticProjection(
      projectionInput({
        progress: {
          consecutiveFailures: 1, lastFailureCode: 'path_timeout', escalationRecommended: false, oscillationsDetected: 0,
          stall: { windowSize: 24, distinctStates: 3, bodyDecisions: 24, semanticDecisions: 2, horizon: 24, maxDistinctStates: 4, exhausted: false, exhaustedRepeats: 0 },
        },
      }),
    ),
  ),
  projectionHash(projection),
  'stall exhaustion vs real progress are different decisions',
)
assert.notEqual(
  projectionHash(buildJevSemanticProjection(projectionInput({ candidates: [candidate({ id: 'WAIT', kind: 'WAIT' })] }))),
  projectionHash(projection),
  'a changed candidate set is a semantic boundary',
)

// --- 6. The compact payload stays inside a semantic bound. A representative
//    decision state is a few KB, not the ~15KB mean the p24 audit measured on
//    the duplicated v6 envelope (the real-corpus reduction is measured on
//    recorded calls by tools/jev-state-audit.mjs --compact-sim).
const compactBytes = Buffer.byteLength(JSON.stringify(payload))
assert.ok(compactBytes < 4096, `compact payload ${compactBytes}B exceeded the 4KB semantic bound`)

// --- 7. Unprojected callers keep the raw legacy shape (route frames, fixtures). ---
const legacy = authorityState({
  stage: 'legacy-test',
  candidates: [candidate({ id: 'WAIT', kind: 'WAIT' })],
  state: (projectedRequest(projection, []) as { state: Record<string, unknown> }).state,
} as never)
assert.ok(legacy.self !== undefined && legacy.signals !== undefined && legacy.candidates !== undefined)
assert.equal((legacy as Record<string, unknown>).schema, undefined)

process.stdout.write('decision-state v9 (§18 Gate B): PASS\n')
