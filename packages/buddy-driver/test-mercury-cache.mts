// test-mercury-cache.mts - the canonical System2 (Mercury) plan cache is
// namespaced by world identity: same-world same-state replays hit, a worldEpoch
// bump invalidates with reason=world.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlannedGoal } from '../jev-agent/src/goalQueue.ts'
import type { System2Outcome, System2PlanRequest } from '../jev-agent/src/system2/service.ts'
import {
  MERCURY_CACHE_FILE_VERSION,
  MERCURY_CACHE_SCHEMA_VERSION,
  MercurySystem2,
  hashMercuryState,
  mercuryCacheIdentity,
} from './mercury-system2.ts'
import type { MercuryStateSummary, MercuryWorldKey } from './mercury-system2.ts'

interface Case {
  name: string
  run: () => Promise<{ pass: boolean; detail: string }> | { pass: boolean; detail: string }
}

const cases: Case[] = []
function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
}

function hostLog(sink: string[]): (event: string, detail?: Record<string, unknown>) => void {
  return (event, detail) => {
    const parts = Object.entries(detail ?? {}).map(([key, value]) => {
      const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)
      return `${key}=${text}`
    })
    sink.push(`${event}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`)
  }
}

function activeGoal(): PlannedGoal {
  return { kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 }
}

function waits(n: number): System2Outcome[] {
  return Array.from({ length: n }, () => ({ actionId: 'WAIT', status: 'ok', failure: null, verified: false, detail: '' }))
}

function mercuryRequest(current: PlannedGoal | null): System2PlanRequest {
  return {
    reason: 'action_impossible',
    detail: 'test',
    tick: 1,
    goalQueueState: {
      depth: current === null ? 0 : 1,
      current:
        current === null
          ? null
          : {
              id: 'g1',
              kind: current.kind,
              description: current.description,
              targetItem: current.targetItem ?? null,
              requiredCount: current.requiredCount ?? 1,
              targetY: null,
              dimension: null,
              startCount: 0,
              haveCount: 0,
              status: 'active',
              origin: 'llm',
              createdAt: 0,
              updatedAt: 0,
              detail: null,
            },
      empty: current === null,
      hasImpossible: false,
      done: 0,
      goals: [],
    },
    objective: { targetItem: 'iron_pickaxe', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: waits(3),
  }
}

function mercurySummary(): MercuryStateSummary {
  return {
    humanMission: 'Defeat the Ender Dragon',
    trigger: 'no_candidate',
    wakeReason: 'action_impossible',
    wakeDetail: 'test',
    position: { x: 10, y: 62, z: 10 },
    dimension: 'minecraft:overworld',
    health: 20,
    toolRank: 2,
    inventory: {},
    stations: { craftingTables: 1, furnaces: 1 },
    knownOres: ['coal_ore', 'iron_ore'],
    recentFailures: [],
    consecutiveWait: 0,
    queue: { depth: 1, done: 3, current: 'collect 3 x raw_iron', hasImpossible: false },
    objective: { targetItem: 'raw_iron', requiredCount: 3, haveCount: 0, complete: false },
    deathHistory: [],
    allowedGoals: { collect: ['stone'], craft: [], smelt: ['charcoal'] },
  }
}

addCase('#33: Mercury cache is world-namespaced (hit same world, miss on epoch bump)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-ns-'))
  const cachePath = join(dir, 'mercury-cache.json')
  const summary = mercurySummary()
  const worldKey: MercuryWorldKey = { serverId: 'srv', dimension: 'minecraft:overworld', worldEpoch: 1 }
  const identity = mercuryCacheIdentity(worldKey)
  writeFileSync(
    cachePath,
    `${JSON.stringify({
      version: MERCURY_CACHE_FILE_VERSION,
      worldKey: identity.worldKey,
      worldEpoch: identity.worldEpoch,
      schemaVersion: MERCURY_CACHE_SCHEMA_VERSION,
      entries: {
        [hashMercuryState(summary, identity)]: {
          op: 'patch',
          goals: [{ item: 'stone', count: 12 }],
          reason: 'need stone',
          strategy: 'mercury_patch_collect_stone',
          costUsd: 0,
          ts: Date.now(),
          worldKey: identity.worldKey,
          schemaVersion: MERCURY_CACHE_SCHEMA_VERSION,
          replays: 0,
        },
      },
      callTimes: [],
      consecutiveStrategy: null,
      consecutiveCount: 0,
    })}\n`,
  )
  const logs: string[] = []
  const mercury = new MercurySystem2({
    summarize: () => summary,
    log: hostLog(logs),
    callsPath: join(dir, 'mercury-calls.jsonl'),
    cachePath,
    worldKey,
    maxPerHour: 0,
  })
  const hit = await mercury.tryRepair(mercuryRequest(activeGoal()), 'no_candidate')
  const logsB: string[] = []
  new MercurySystem2({
    summarize: () => summary,
    log: hostLog(logsB),
    callsPath: join(dir, 'mercury-calls.jsonl'),
    cachePath,
    worldKey: { serverId: 'srv', dimension: 'minecraft:overworld', worldEpoch: 2 },
    maxPerHour: 0,
  })
  const invalidated = logsB.find((line) => line.includes('PLANNER_CACHE_INVALIDATED') && line.includes('reason=world'))
  const hitLine = logs.find((line) => line.includes('PLANNER_CACHE') && line.includes('hit=true'))
  return {
    pass: hit !== null && hit.cached && hit.op === 'patch' && invalidated !== undefined && hitLine !== undefined,
    detail: `cached=${hit?.cached ?? false} op=${hit?.op ?? 'none'} hit=${hitLine ?? 'none'} invalidated=${invalidated ?? 'none'}`,
  }
})

let failures = 0
process.stdout.write('Mercury plan cache namespacing (#33)\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} mercury-cache cases passed\n`)
if (failures > 0) process.exit(1)
