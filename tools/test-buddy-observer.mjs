#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { buildAiSummary, buildObserverSnapshot, parseBuddyLogLine, parseDetail, parseRunnerOutEvents } from './buddy-observer.mjs'

const detail = parseDetail('action=MINE:b1 abandon=0.37 decision=continue goals=["collect 3 x iron","smelt 3 x iron_ingot"] note="has spaces"')
assert.equal(detail.action, 'MINE:b1')
assert.equal(detail.abandon, 0.37)
assert.equal(detail.decision, 'continue')
assert.deepEqual(detail.goals, ['collect 3 x iron', 'smelt 3 x iron_ingot'])
assert.equal(detail.note, 'has spaces')

const parsed = parseBuddyLogLine('[2026-09-21T12:00:00.000Z] JEV_HEADS action=MINE:b1 abandon=0.37 decision=continue betaAuthority=false')
assert.equal(parsed?.event, 'JEV_HEADS')
assert.equal(parsed?.detail.action, 'MINE:b1')
assert.equal(parsed?.detail.betaAuthority, false)

const fatalEvents = parseRunnerOutEvents([
  '[2026-09-21T12:00:00.000Z] BOOT pid=1 runId=run-1 source=abc',
  '[policy] FATAL {"trigger":"block_broken","code":"MODEL_UNAVAILABLE","context":"jev-authority","attempts":4,"error":"GatewayInternalServerError: Service unavailable; Bearer abc123"}',
  '[2026-09-21T12:00:10.000Z] ERROR code=MODEL_UNAVAILABLE action=terminate-resident pid=1 exitCode=1',
], { runId: 'run-1', bootTs: '2026-09-21T12:00:00.000Z' })
assert.equal(fatalEvents.length, 1)
assert.equal(fatalEvents[0]?.ts, '2026-09-21T12:00:10.000Z')
assert.equal(fatalEvents[0]?.detail.runId, 'run-1')
assert.equal(fatalEvents[0]?.detail.context, 'jev-authority')
assert.match(fatalEvents[0]?.detail.error ?? '', /Bearer \[REDACTED\]/)
assert.doesNotMatch(fatalEvents[0]?.detail.error ?? '', /abc123/)
assert.deepEqual(parseRunnerOutEvents([
  '[2026-09-21T12:00:00.000Z] BOOT pid=1 runId=old source=abc',
  '[policy] FATAL {"code":"MODEL_UNAVAILABLE","context":"jev-authority"}',
  '[2026-09-21T12:00:10.000Z] ERROR code=MODEL_UNAVAILABLE action=terminate-resident pid=1 exitCode=1',
], { runId: 'run-2', bootTs: '2026-09-21T12:01:00.000Z' }), [])

const report = {
  ok: true,
  data: {
    runId: 'run-1',
    connected: true,
    frozen: false,
    generationId: 'gen-7',
    generationHash: 'abc123',
    milestone: 'iron_pickaxe',
    worldKey: { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 1 },
    status: {
      rungId: 'diamond',
      rungIndex: 9,
      policyKind: 'jev',
      policyProvider: 'typesafe-ai',
      policyModel: 'typesafe-ai/jev',
      system2AuthorityStack: { provider: 'local-mercury', model: 'deterministic|mercury:qwen3.5-9b-local' },
      system2LastAuthority: { provider: 'mercury', model: 'qwen3.5-9b-local' },
      deterministicFallbackEnabled: false,
      queue: {
        depth: 2,
        done: 4,
        revision: 11,
        current: {
          id: 'g5',
          kind: 'collect',
          description: 'collect 3 x raw_iron',
          status: 'active',
          targetItem: 'raw_iron',
          haveCount: 1,
          requiredCount: 3,
          semanticOptionIntent: 'rebuild equipment',
          semanticOptionTemplateId: 'collect:raw_iron',
          semanticOptionInstanceId: 'collect:raw_iron#c3',
        },
      },
      currentAction: { id: 'MINE:b1', kind: 'MINE', phase: 'running', startedAt: 1 },
      truth: { position: { x: 1, y: 62, z: 3 }, health: 18, food: 17, dimension: 'minecraft:overworld', onGround: true, inventory: { raw_iron: 1 } },
    },
  },
}

const events = [
  parseBuddyLogLine('[2026-09-21T12:00:00.000Z] SYSTEM2_AUTHORITY_INPUT provider=mercury model=qwen3.5-9b-local trigger=post_death reason=no_progress'),
  parseBuddyLogLine('[2026-09-21T12:00:01.000Z] SYSTEM2_AUTHORITY_DECISION provider=mercury model=qwen3.5-9b-local trigger=post_death strategy=rebuild_equipment goals=["collect 3 x raw_iron"]'),
  parseBuddyLogLine('[2026-09-21T12:00:02.000Z] JEV_HEADS action=MINE:b1 abandon=0.37 decision=continue betaAuthority=false'),
  parseBuddyLogLine('[2026-09-21T12:00:03.000Z] ACTION n=9 id=MINE:b1 kind=MINE phase=running rung=diamond'),
].filter((event) => event !== null)

const snapshot = buildObserverSnapshot({ report, events, mission: { id: 'M4', title: 'Ender Dragon' }, now: 1_795_000_000_000 })
assert.equal(snapshot.resident.connected, true)
assert.equal(snapshot.goal.frontier, 'diamond')
assert.equal(snapshot.goal.queue.current?.description, 'collect 3 x raw_iron')
assert.equal(snapshot.option?.intent, 'rebuild equipment')
assert.equal(snapshot.decisionTrace.jev?.detail.action, 'MINE:b1')
assert.equal(snapshot.decisionTrace.system2Decision?.detail.strategy, 'rebuild_equipment')
assert.equal(snapshot.action?.kind, 'MINE')
assert.equal(snapshot.authority.system2?.last?.model, 'qwen3.5-9b-local')

const aiSummary = buildAiSummary({
  ...snapshot,
  resident: { ...snapshot.resident, available: false, connected: false },
  events: [...snapshot.events, fatalEvents[0]],
})
assert.equal(aiSummary.runtimeFailure?.event, 'FATAL')
assert.equal(aiSummary.runtimeFailure?.detail.context, 'jev-authority')
assert.equal(aiSummary.status.availabilityReason, 'MODEL_UNAVAILABLE')
assert.match(aiSummary.headline, /Runtime failure: MODEL_UNAVAILABLE \(jev-authority\)/)

console.log('buddy-observer: PASS')
