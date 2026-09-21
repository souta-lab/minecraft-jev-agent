#!/usr/bin/env bun
// tools/test-agent-report.mjs - offline fixture test for tools/agent-report.mjs.
//
// Builds a synthetic buddy.log + control-report JSON that reproduce the known
// "stuck on PLACE:furnace, FURNACE_READY=0" situation, then asserts the report
// detects the blockers, the reload failure, and the VERDICT - without needing
// the live resident, a socket, or any network.
//
// Usage: bun tools/test-agent-report.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOOL = path.join(HERE, 'agent-report.mjs')

const T0 = Date.parse('2026-09-18T00:00:00.000Z')
const at = (min) => new Date(T0 + min * 60000).toISOString()
const line = (min, body) => `[${at(min)}] ${body}`

// Constant inventory (so "no inventory change" is true for the whole window).
const INV = '{"cobblestone":20,"coal":3,"raw_iron":4}'

const fixtureLog = []
for (let m = 0; m <= 29; m++) {
  fixtureLog.push(line(m, `ACTION n=${180 + m} id=PLACE:furnace:p29_61_35 kind=PLACE phase=placing pos=29.30,60.00,34.30 rung=charcoal`))
  if (m % 3 === 0) fixtureLog.push(line(m, `HEARTBEAT pos=29.30,60.00,34.30 health=20 running=true rung=charcoal queue=craft 1 x furnace depth=3 done=1 action=PLACE inv=${INV}`))
}
for (let i = 0; i < 12; i++) fixtureLog.push(line(i + 1, 'JEV_HEADS action=PLACE:furnace:p29_61_35 abandon=1 decision=replan chainId=fix-0000-0000-0000-00000000000' + i))
fixtureLog.push(
  line(2, 'JEV_HEADS action=PLACE:furnace:p29_61_35 abandon=0 decision=continue'),
  line(4, 'REPLAN_THROTTLED reason=no_progress ageMs=500 stateHash=deadbeef because=no_new_info'),
  line(9, 'REPLAN_THROTTLED reason=no_progress ageMs=800 stateHash=deadbeef because=no_new_info'),
  line(10, 'REPLAN_REJECTED reason=no_body_delta requested=two_rungs current=place:furnace note=mercury unavailable'),
  line(11, 'WAIT_LIMIT n=8 strategy=mercury_replace_craft_furnace'),
  line(12, 'PRECONDITION_MISSING goal=craft 1 x furnace need=8 x cobblestone rungId=charcoal'),
  line(12, 'LADDER_PREREQ goal=craft 1 x furnace need=8 x cobblestone rungId=charcoal replace=["craft 1 x furnace"]'),
  line(13, 'MOVE_UNREACHABLE actionId=MOVE:p40_8_31 reason=no_path'),
  line(14, 'RETRIEVE_STALLED target={"x":29,"y":61,"z":35} dist=53 ticks=40'),
  line(15, 'DESCEND_STALLED y=11.0 targetY=8 stallTicks=4 hasDescendCandidate=false'),
  line(16, 'DIG_OSCILLATE actionId=DIG:b39_11_31 region=39_11_31'),
  line(17, 'MOVE_OSCILLATE actionId=MOVE:p40_8_31 region=39_8_32'),
  line(18, 'RELOAD ok=true trigger=source-changed ms=140 hash=aaaa11112222 id=gen-fixture-old generations=10'),
  line(28, 'RELOAD ok=false trigger=source-changed ms=150 message=Cannot read properties of undefined (reading \'goals\')'),
  line(19, 'LADDER_RESET reason=death invEmpty=true rungIndex=0 rungId=wood goals=["collect 3 x log"]'),
  line(20, 'LADDER_RESUME rung=charcoal rungIndex=3 reason=inventory-resume invEmpty=false'),
  line(21, 'PLAN source=fallback goals=["craft 1 x furnace"] cost=0 ms=6 reason=stuck rung=charcoal cached=false note=mercury unavailable'),
  line(22, 'ADVISOR source=fallback reason=no_progress strategy=deterministic_ladder cost=0 ms=0'),
  line(23, 'BETA_SHADOW optionId=craft:furnace beta=1 threshold=0.5 would=abandon actual=abandon agree=true mode=authority'),
  line(24, 'CAUSAL record=causal chainId=c0 optionId=craft:furnace planId=g1:craft:furnace strategy=llm:craft candidateId=PLACE:furnace:p29_61_35 actionId=PLACE:furnace:p29_61_35 verified=true status=done resource=null progressDelta=0'),
  line(25, 'KNOWN_RESOURCE item=iron_ore kind=ore at=26,8,35 worldEpoch=1'),
  line(26, 'KNOWN_RESOURCE item=furnace name=furnace target=29,61,35 dist=53 vertical=none'),
)
const fixtureLogText = fixtureLog.join('\n') + '\n'

const fixtureReport = {
  ok: true,
  data: {
    runId: 'run-fixture',
    frozen: false,
    connected: true,
    generations: 42,
    reloads: 7,
    recoveries: 3,
    milestone: 'iron_ingot',
    username: 'AI_Buddy',
    worldKey: { serverId: '127.0.0.1:25565', dimension: 'minecraft:overworld', worldEpoch: 1 },
    generationId: 'gen-fixture',
    generationHash: 'deadbeefcafe',
    contractVersion: 2,
    lease: { activeId: 'gen-fixture', acquisitions: 2, revocations: 0 },
    stats: { reconnects: 0, reconnectsLastHour: 0, reloadsChangedHash: 1, reloadsFailed: 0, wedge: true, goalComplete: false },
    worldMemory: { craftingTables: 3, furnaces: 0, discoveredOres: ['coal_ore', 'iron_ore'], traversalFailures: 2, hazards: 1, hardHazards: 0 },
    listenerLeak: false,
    status: {
      policyKind: 'fallback',
      plannedGoals: 4,
      ready: true,
      rungId: 'charcoal',
      rungIndex: 3,
      currentAction: { id: 'PLACE:furnace:p29_61_35', kind: 'PLACE', phase: 'placing', startedAt: T0 + 60000 },
      queue: {
        depth: 3,
        done: 1,
        empty: false,
        hasImpossible: false,
        current: { id: 'g1:craft:furnace', description: 'craft 1 x furnace', status: 'active' },
        goals: [
          { id: 'g1:craft:furnace', description: 'craft 1 x furnace', status: 'active', origin: 'llm' },
          { id: 'g2:smelt:charcoal', description: 'smelt 1 x charcoal', status: 'pending', origin: 'llm' },
        ],
      },
      truth: { position: { x: 29.3, y: 60.0, z: 34.3 }, health: 20, food: 20, onGround: true, inventory: JSON.parse(INV) },
    },
  },
}

let checks = 0
let passed = 0
function check(name, fn) {
  checks++
  try {
    fn()
    passed++
  } catch (error) {
    process.stderr.write(`FAIL ${name}\n${error && error.stack ? error.stack : String(error)}\n`)
    throw error
  }
}

function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' })
  return r
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-report-fixture-'))
const logPath = path.join(dir, 'buddy.log')
const reportPath = path.join(dir, 'report.json')
writeFileSync(logPath, fixtureLogText)
writeFileSync(reportPath, JSON.stringify(fixtureReport))

try {
  const jsonRun = run(['--log', logPath, '--report', reportPath, '--no-socket', '--json'])
  check('--json exits 0', () => assert.equal(jsonRun.status, 0, jsonRun.stderr))
  let report
  check('--json parses', () => {
    report = JSON.parse(jsonRun.stdout)
    assert.equal(report.identity.runId, 'run-fixture')
  })
  check('verdict names PLACE:furnace', () => {
    assert.match(report.stuck.verdict, /^VERDICT: stuck at PLACE:furnace/)
    assert.match(report.stuck.verdict, /repeated \d+x/)
    assert.match(report.stuck.verdict, /no inventory change/)
  })
  check('abandoned blocker groups PLACE:furnace', () => {
    const hit = report.blockers.abandoned.byAction.find((x) => x.action === 'PLACE:furnace:p29_61_35')
    assert.ok(hit, 'PLACE:furnace abandon entry missing')
    assert.ok(hit.count >= 3, `expected >=3, got ${hit.count}`)
    assert.ok(report.blockers.abandoned.total >= 12)
  })
  check('REPLAN_THROTTLED / REJECTED / WAIT_LIMIT counts', () => {
    assert.equal(report.blockers.replanThrottled.count, 2)
    assert.equal(report.blockers.replanRejected.count, 1)
    assert.equal(report.blockers.waitLimit.count, 1)
    assert.equal(report.blockers.preconditionMissing.count, 1)
    assert.equal(report.blockers.ladderPrereq.count, 1)
  })
  check('oscillation / stall blockers detected', () => {
    assert.equal(report.blockers.moveUnreachable.count, 1)
    assert.equal(report.blockers.retrieveStalled.count, 1)
    assert.equal(report.blockers.descendStalled.count, 1)
    assert.equal(report.blockers.digOscillate.count, 1)
    assert.equal(report.blockers.moveOscillate.count, 1)
  })
  check('last RELOAD is a failure', () => {
    assert.equal(report.blockers.reload.lastOk, false)
    assert.equal(report.blockers.reload.failures, 1)
    assert.match(report.blockers.reload.lastFailure.message, /reading 'goals'/)
  })
  check('LADDER_RESET / RESUME captured', () => {
    assert.equal(report.blockers.ladderReset.count, 1)
    assert.equal(report.blockers.ladderReset.examples.at(-1).reason, 'death')
    assert.equal(report.blockers.ladderResume.count, 1)
    assert.equal(report.blockers.ladderResume.examples.at(-1).rung, 'charcoal')
  })
  check('FURNACE_READY reported absent (0)', () => {
    assert.equal(report.blockers.furnaceReady.markerCount, 0)
    assert.equal(report.blockers.furnaceReady.ready, false)
  })
  check('worldMemory + ore coordinates present', () => {
    assert.equal(report.resources.worldMemory.furnaces, 0)
    const ore = report.resources.knownResources.find((x) => x.item === 'iron_ore')
    assert.ok(ore, 'iron_ore coordinates missing')
    assert.equal(ore.target, '26,8,35')
  })
  check('stuck signals: pinned + repeated + stale inventory + abandons', () => {
    assert.equal(report.stuck.pinned, true)
    assert.equal(report.stuck.repeated, true)
    assert.equal(report.stuck.staleInv, true)
    assert.equal(report.stuck.abandoning, true)
  })
  check('recent decisions include all five kinds', () => {
    const kinds = new Set(report.decisions.recent.map((d) => d.kind))
    for (const k of ['PLAN', 'ADVISOR', 'JEV_HEADS', 'BETA_SHADOW', 'CAUSAL']) assert.ok(kinds.has(k), `missing decision kind ${k}`)
  })

  const whyRun = run(['--log', logPath, '--report', reportPath, '--no-socket', '--why'])
  check('--why exits 0 and prints only blockers/verdict', () => {
    assert.equal(whyRun.status, 0, whyRun.stderr)
    assert.match(whyRun.stdout, /VERDICT: stuck at PLACE:furnace/)
    assert.match(whyRun.stdout, /FURNACE_READY\s+0/)
    assert.doesNotMatch(whyRun.stdout, /-- 1\. Identity/)
    assert.doesNotMatch(whyRun.stdout, /-- 2\. Mission/)
    assert.ok(whyRun.stdout.split('\n').length <= 120)
  })

  const humanRun = run(['--log', logPath, '--report', reportPath, '--no-socket'])
  check('human report has blockers + verdict and is bounded', () => {
    assert.equal(humanRun.status, 0, humanRun.stderr)
    assert.match(humanRun.stdout, /-- 4\. Blockers --/)
    assert.match(humanRun.stdout, /VERDICT: stuck at PLACE:furnace/)
    assert.ok(humanRun.stdout.split('\n').length <= 120, `too many lines: ${humanRun.stdout.split('\n').length}`)
  })

  const noReport = run(['--log', logPath, '--no-socket', '--why'])
  check('log-only mode still yields a verdict (agent/socket down)', () => {
    assert.equal(noReport.status, 0, noReport.stderr)
    assert.match(noReport.stdout, /VERDICT: stuck at PLACE:furnace/)
  })

  const missingLog = run(['--log', path.join(dir, 'does-not-exist.log'), '--no-socket', '--json'])
  check('missing log is graceful (exit 0, no crash)', () => {
    assert.equal(missingLog.status, 0, missingLog.stderr)
    assert.doesNotMatch(missingLog.stderr, /unrecoverable/)
  })

  process.stdout.write(`test-agent-report: ${passed}/${checks} checks passed\n`)
  process.stdout.write(`fixture verdict: ${report.stuck.verdict}\n`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
