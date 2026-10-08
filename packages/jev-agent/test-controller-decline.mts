// p27: singleton DECLINE reaches the protected abandonment lifecycle and
// is recorded without an actuation WAIT, guard disappearance or VERIFY claim.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import type { Bot } from 'mineflayer'
import type { Candidate } from './src/candidates.ts'
import { JevController } from './src/controller.ts'
import type { JevResult } from './src/jev.ts'
import { createTestKernelAuthority } from './test-vtr-kernel-authority-stub.mts'

const require = createRequire(import.meta.url)
const Vec3 = require('vec3')
const registry = require('minecraft-data')('1.21.11')
const origin = { x: 0, y: 64, z: 0 }
const oakAt = { x: 8, y: 64, z: 0 }
const birchAt = { x: 0, y: 64, z: 8 }

function makeBot(): Bot {
  const position = new Vec3(origin.x, origin.y, origin.z)
  const logs = new Map([
    [`${oakAt.x},${oakAt.y},${oakAt.z}`, 'oak_log'],
    [`${birchAt.x},${birchAt.y},${birchAt.z}`, 'birch_log'],
  ])
  const blockAt = (cell: { x: number; y: number; z: number }) => {
    const key = `${cell.x},${cell.y},${cell.z}`
    const name = logs.get(key) ?? (cell.y <= 63 ? 'stone' : 'air')
    const solid = name !== 'air'
    return {
      name,
      boundingBox: solid ? 'block' : 'empty',
      diggable: solid,
      position: new Vec3(cell.x, cell.y, cell.z),
    }
  }
  const findBlocks = (options: {
    matching: (block: { name: string }) => boolean
    maxDistance?: number
    count?: number
  }): unknown[] => {
    const maxDistance = options.maxDistance ?? 48
    const count = options.count ?? 256
    const out: unknown[] = []
    for (const [key, name] of logs) {
      if (!options.matching({ name })) continue
      const [x, y, z] = key.split(',').map(Number) as [number, number, number]
      if (Math.hypot(x - origin.x, y - origin.y, z - origin.z) > maxDistance) continue
      out.push(new Vec3(x, y, z))
      if (out.length >= count) break
    }
    return out
  }
  return {
    username: 'AI_VTR_TICK',
    entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: 20,
    game: { gameMode: 'survival', dimension: 'minecraft:overworld', minY: -64, height: 384 },
    time: { isDay: true },
    registry,
    entities: {},
    // Exercise the production MineflayerReachRuntimeAdapter's real path-probe
    // boundary. The adapter converts this grounded path to the typed CAN fact;
    // the test does not inject ReachRoute or reachability evidence directly.
    pathfinder: {
      movements: {},
      getPathTo: (_movements: unknown, goal: { x: number; y: number; z: number }) => ({
        status: 'success',
        path: [
          { x: origin.x, y: origin.y, z: origin.z },
          { x: goal.x, y: goal.y, z: goal.z },
        ],
      }),
    },
    inventory: { items: () => [], count: () => 0 },
    blockAt,
    canSeeBlock: () => true,
    findBlocks,
    on: () => undefined,
    once: () => undefined,
    removeListener: () => undefined,
  } as never
}

function vote(action: string, beta = 0.1): JevResult {
  return {
    callId: `fixture-${action}`, policy: 'typesafe', source: 'jev', model: 'fixture',
    latencyMs: 0, usage: null,
    answers: {
      action: { name: 'action', type: 'choice', value: action, probability: 0.9,
        confidence: 0.8, probabilities: { [action]: 0.9 }, legend: null, note: null },
      abandon_option: { name: 'abandon_option', type: 'boolean', value: beta,
        probability: beta, confidence: null, probabilities: { true: beta, false: 1-beta },
        legend: null, note: null },
    },
  }
}

function fixture() {
  const logDir = mkdtempSync(join(tmpdir(), 'controller-decline-'))
  const controller = new JevController(makeBot(), {
    kernelAuthority: createTestKernelAuthority(), vtrMission: null,
    goalItem: 'log', goalCount: 1, serverId: 'fixture', worldEpoch: 1,
    decisionProvenance: { generationId: 'decline-gen', runId: 'decline-run', sourceSha: 'decline-source' },
    actuationPort: { generationId: 'decline-lease', assertLease: () => undefined } as never,
    logDir, forceFallbackPolicy: true, verbose: false, betaAbandonDeferCycles: 3,
  })
  const host = controller as unknown as Record<string, any>
  host.summonLlm = () => null
  host.unfinishedGoals = () => []
  return { controller, host, logDir, dispose: () => { host.running = false; rmSync(logDir, { recursive: true, force: true }) } }
}

test('explicit singleton refusal reaches abandonment with low beta, while ordinary WHICH and absent Option do not', () => {
  const f = fixture()
  try {
    const decline = vote('DECLINE')
    assert.equal(f.host.abandonVerdict(vote('MOVE:fixture'), 'collect:food', 'g1').adopt, false)
    f.host.recentOutcomes = [{ execution: 'control', control: 'wait', progress: 'none', progressKinds: [], failure: null }]
    const verdicts = Array.from({ length: 3 }, () => f.host.abandonVerdict(decline, 'collect:food', 'g1'))
    assert.deepEqual(verdicts.map(v => v.adopt), [false, false, true],
      'the explicit model refusal must honor the existing bounded control deferral')
    const wakes: string[] = []
    const retired: string[] = []
    f.host.markOptionAbandoned = (id: string) => retired.push(id)
    f.host.summonLlm = (reason: string) => { wakes.push(reason); return null }
    assert.equal(f.host.applyAbandon(decline, verdicts[2]), true)
    assert.deepEqual(retired, ['collect:food'])
    assert.deepEqual(wakes, ['no_progress'], 'existing lifecycle wakes System2 without selecting WHAT')
    assert.equal(decline.answers.abandon_option!.probability, 0.1, 'raw Noul probability stays unchanged')
    assert.equal(f.host.abandonVerdict(decline, null, null).adopt, false, 'no Option cannot be abandoned')
    f.host.unfinishedGoals = () => [{ kind: 'smelt', targetItem: 'iron_ingot' }]
    assert.equal(f.host.betaDecision(vote('PLACE:furnace:p1_64_0', 0.9)).adopt, false,
      'the ordinary prerequisite protection gate remains intact')
  } finally { f.dispose() }
})

test('full tick records DECLINE without unoffered WAIT, guard disappearance, executor claim or success', async () => {
  const f = fixture()
  try {
    const claims: string[] = []
    let providerCalls = 0
    f.host.running = true
    f.host.syncQueue = () => undefined
    f.host.syncGoalToQueue = () => undefined
    f.host.reachabilityGateOptions = () => ({ pathProbe: () => 'reachable', stationApproach: null })
    f.host.filterMoveCandidates = (candidates: Candidate[]) => {
      const candidate = candidates.find(c => c.kind === 'MOVE')
      assert.ok(candidate, 'the real generator must produce a grounded MOVE')
      return [candidate]
    }
    f.host.jev = {
      kind: 'typesafe', model: 'fixture',
      decide: async ({ candidates }: { candidates: readonly Candidate[] }) => {
        providerCalls++
        assert.equal(candidates.length, 1)
        assert.equal(candidates.some(c => c.id === 'WAIT'), false)
        return vote('DECLINE')
      },
    }
    ;(f.controller.agent as unknown as Record<string, any>).claim = (candidate: Candidate) => {
      claims.push(candidate.id)
      throw Error('DECLINE must never actuate')
    }
    await f.host.tick('heartbeat', {})
    assert.equal(providerCalls, 1, 'Typed Decision Plane authority remains required')
    assert.deepEqual(claims, [])
    assert.equal(f.host.guardRejections, 0, 'an explicit refusal is not a vanished candidate')
    const rows = readFileSync(join(f.logDir, 'decisions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    assert.equal(rows.length, 1, 'the refusal must remain source-bound evidence')
    assert.equal(rows[0].chosenAction, 'DECLINE')
    assert.equal(rows[0].jev.answers.action.value, 'DECLINE')
    assert.equal(rows[0].result, null, 'there was no execution or VERIFY success')
    assert.equal(rows[0].sourceSha, 'decline-source')
    const outcomes = readFileSync(join(f.logDir, 'jev-calls.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).map(l => JSON.parse(l)).filter(r => r.record === 'jev-outcome')
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].executed, false)
    assert.equal(outcomes[0].verified, false)
    assert.equal(outcomes[0].actionId, null)
  } finally { f.dispose() }
})

test('cached singleton DECLINE continues the bounded abandonment lifecycle without a provider requery', async () => {
  const f = fixture()
  try {
    const claims: string[] = []
    const retired: string[] = []
    const wakes: string[] = []
    let providerCalls = 0
    f.host.running = true
    f.host.syncQueue = () => undefined
    f.host.syncGoalToQueue = () => undefined
    f.host.reachabilityGateOptions = () => ({ pathProbe: () => 'reachable', stationApproach: null })
    f.host.filterMoveCandidates = (candidates: Candidate[]) => {
      const candidate = candidates.find(c => c.kind === 'MOVE')
      assert.ok(candidate, 'the real generator must produce a grounded MOVE')
      return [candidate]
    }
    f.host.queue.applyPlan([{
      kind: 'collect', description: 'collect 1 x log', targetItem: 'log', requiredCount: 1,
      optionInstanceId: 'collect:log', optionTemplateId: 'collect:log',
      semanticOptionInstanceId: 'collect:log', semanticOptionTemplateId: 'collect:log',
      semanticOptionIntent: 'collect log',
    }], 'llm', 'replace')
    f.host.recentOutcomes = [{
      execution: 'control', control: 'wait', progress: 'none', progressKinds: [], failure: null,
    }]
    f.host.markOptionAbandoned = (id: string) => retired.push(id)
    f.host.summonLlm = (reason: string) => { wakes.push(reason); return null }
    f.host.jev = {
      kind: 'typesafe', model: 'fixture',
      decide: async () => {
        providerCalls++
        return vote('DECLINE')
      },
    }
    ;(f.controller.agent as unknown as Record<string, any>).claim = (candidate: Candidate) => {
      claims.push(candidate.id)
      throw Error('DECLINE must never actuate')
    }

    await f.host.tick('heartbeat', {})
    await f.host.tick('heartbeat', {})
    await f.host.tick('heartbeat', {})

    assert.equal(providerCalls, 1,
      `semantic replay must not spend another provider call; queue=${f.host.queue.current?.id ?? 'none'} wakes=${JSON.stringify(wakes)} outcomes=${f.host.jevCalls}`)
    assert.deepEqual(claims, [], 'DECLINE must never claim an executor capability')
    assert.equal(retired.length, 1,
      `the bounded deferred refusal must eventually retire the current option; queue=${f.host.queue.current?.id ?? 'none'} deferrals=${f.host.betaAbandonDeferral.count()} lastAdopted=${f.host.lastAbandonAdopted} wakes=${JSON.stringify(wakes)}`)
    assert.deepEqual(wakes, ['no_progress'], 'the existing lifecycle hands WHAT repair to System2')
    const outcomes = readFileSync(join(f.logDir, 'jev-calls.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).map(l => JSON.parse(l)).filter(r => r.record === 'jev-outcome')
    assert.ok(outcomes.length >= 3, 'each replay remains non-actuating outcome evidence')
    assert.ok(outcomes.every((row: { executed: boolean; verified: boolean; actionId: string | null }) =>
      row.executed === false && row.verified === false && row.actionId === null))
  } finally { f.dispose() }
})
