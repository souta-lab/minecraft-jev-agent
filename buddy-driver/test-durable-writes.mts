// test-durable-writes.mts - issue #5: speculative generations return PROPOSALS and
// never write durable state. The HOST validates (with the #48 lineage guard) and
// commits once at the commit point; a rejected candidate leaves bytes unchanged.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSnapshot, LedgerProposalEnvelope, ResidentWorldMemory } from './resident-types.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { GoalQueueSnapshot } from '../jev-agent/src/goalQueue.ts'
import { AGENT_SNAPSHOT_SCHEMA_VERSION, bumpRevision } from './state-snapshot.ts'
import { durableWriteLanded } from './host-durability.ts'
import {
  DURABLE_WRITE_VIOLATION,
  commitPendingProposals,
  guardedDurableWrite,
  hasPendingProposals,
  newPendingProposals,
  setStrictSpeculativeWrites,
  stageLedgerProposal,
  stageLedgerReconciliation,
  stageWorldMemory,
  validateLedgerProposal,
  writeSnapshotAtomic,
} from './proposal-staging.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

interface Captured {
  events: Array<{ event: string; detail: Record<string, unknown> }>
  log: (event: string, detail?: Record<string, unknown>) => void
}

function capture(): Captured {
  const events: Captured['events'] = []
  return { events, log: (event, detail) => events.push({ event, detail: detail ?? {} }) }
}

const WORLD_KEY = '127.0.0.1:25565|minecraft:overworld|1'

function ledger(counter: number, targetItem = 'raw_iron'): GoalQueueSnapshot {
  return {
    counter,
    goals: [
      {
        id: `g${counter}:collect:${targetItem}`,
        kind: 'collect',
        description: `collect ${counter} x ${targetItem}`,
        targetItem,
        requiredCount: counter,
        targetY: null,
        dimension: null,
        startCount: 0,
        haveCount: 0,
        status: 'active',
        origin: 'llm',
        createdAt: 1,
        updatedAt: 2,
        detail: null,
      },
    ],
  }
}

function snapshot(revision: number, generationId: string, memory?: ResidentWorldMemory): AgentSnapshot {
  const memoryByKey: Record<string, ResidentWorldMemory> = {}
  if (memory !== undefined) memoryByKey[WORLD_KEY] = memory
  return {
    schemaVersion: AGENT_SNAPSHOT_SCHEMA_VERSION,
    revision,
    worldEpoch: 1,
    generationId,
    bot: 'AI_M1DW',
    serverId: '127.0.0.1:25565',
    dimension: 'minecraft:overworld',
    levelName: null,
    firstSeenAt: 1,
    updatedAt: 1,
    milestoneIndex: -1,
    milestone: null,
    ledger: ledger(1),
    worldMemoryByKey: memoryByKey,
    generations: 0,
    reloads: 0,
    recoveries: 0,
    lastGenerationId: generationId,
    actions: 0,
  }
}

function withTempState(): { dir: string; statePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'durable-writes-'))
  const statePath = join(dir, 'buddy-state.json')
  return { dir, statePath }
}

addCase('#5(a): a speculative generation stages proposals but leaves the file byte-identical', () => {
  const { dir, statePath } = withTempState()
  try {
    const state = snapshot(10, 'gen-old', emptyWorldMemory())
    writeSnapshotAtomic(statePath, state)
    const before = readFileSync(statePath)

    const pending = newPendingProposals()
    pending.generationId = 'gen-new'
    stageWorldMemory(pending, {
      craftingTables: [{ x: 1, y: 64, z: 2 }],
      discoveredOres: ['iron_ore'],
      moveFailures: [
        {
          key: 'overworld:9,64,9',
          dimension: 'overworld',
          x: 9,
          y: 64,
          z: 9,
          attempts: 3,
          firstFailedAt: 1,
          lastFailedAt: 2,
          lastReason: 'unreachable',
          blacklistedUntil: 30_000,
        },
      ],
    })
    stageLedgerProposal(pending, { ledger: ledger(5), baseRevision: 10, generationId: 'gen-new' })
    stageLedgerReconciliation(pending, { generationId: 'gen-new', reason: 'live inventory regressed' })

    const after = readFileSync(statePath)
    const onDisk = JSON.parse(after.toString('utf8')) as AgentSnapshot
    const pass =
      before.equals(after) &&
      hasPendingProposals(pending) &&
      pending.worldMemory.length === 1 &&
      pending.ledger?.baseRevision === 10 &&
      (onDisk.worldMemoryByKey[WORLD_KEY]?.craftingTables.length ?? -1) === 0 &&
      (onDisk.worldMemoryByKey[WORLD_KEY]?.moveFailures.length ?? -1) === 0 &&
      onDisk.ledger?.counter === 1
    return { pass, detail: `bytesUnchanged=${before.equals(after)} stagedDeltas=${pending.worldMemory.length} stagedLedger=${pending.ledger !== null} diskLedgerCounter=${onDisk.ledger?.counter}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#5(b): a stale ledger proposal is rejected and the file stays byte-identical', () => {
  const { dir, statePath } = withTempState()
  try {
    const state = snapshot(12, 'gen-B', emptyWorldMemory())
    writeSnapshotAtomic(statePath, state)
    const before = readFileSync(statePath)
    const cap = capture()

    const pending = newPendingProposals()
    pending.generationId = 'gen-A'
    stageLedgerProposal(pending, { ledger: ledger(9, 'diamond'), baseRevision: 10, generationId: 'gen-A' })

    let saveCalls = 0
    const result = commitPendingProposals(
      {
        pending,
        memory: emptyWorldMemory(),
        state,
        guard: { revision: 12, committedGenerationId: 'gen-B', activeGenerationId: 'gen-B' },
        log: cap.log,
        save: () => {
          saveCalls += 1
          bumpRevision(state)
          writeSnapshotAtomic(statePath, state)
          return durableWriteLanded('reload-commit', state.revision)
        },
      },
      'reload-commit',
    )

    const after = readFileSync(statePath)
    const rejected = cap.events.find((event) => event.event === 'STATE_PROPOSAL_REJECTED')
    const pass =
      !result.ledgerApplied &&
      result.ledgerRejected === 'stale-revision' &&
      result.writes === 0 &&
      saveCalls === 0 &&
      before.equals(after) &&
      rejected !== undefined &&
      rejected.detail.reason === 'stale-revision' &&
      state.ledger?.counter === 1
    return { pass, detail: `reason=${result.ledgerRejected} writes=${result.writes} saveCalls=${saveCalls} bytesUnchanged=${before.equals(after)} log=${JSON.stringify(rejected?.detail ?? null)}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#48: a superseded generation proposal is rejected by lineage even at the same revision', () => {
  const { dir, statePath } = withTempState()
  try {
    const state = snapshot(12, 'gen-B', emptyWorldMemory())
    writeSnapshotAtomic(statePath, state)
    const before = readFileSync(statePath)
    const cap = capture()

    const proposal: LedgerProposalEnvelope = { ledger: ledger(9, 'diamond'), baseRevision: 12, generationId: 'gen-A' }
    const verdict = validateLedgerProposal(proposal, { revision: 12, committedGenerationId: 'gen-B', activeGenerationId: 'gen-B' })
    const pending = newPendingProposals()
    pending.generationId = 'gen-A'
    stageLedgerProposal(pending, proposal)
    const result = commitPendingProposals(
      {
        pending,
        memory: emptyWorldMemory(),
        state,
        guard: { revision: 12, committedGenerationId: 'gen-B', activeGenerationId: 'gen-B' },
        log: cap.log,
        save: () => {
          writeSnapshotAtomic(statePath, state)
          return durableWriteLanded('reload-commit', state.revision)
        },
      },
      'reload-commit',
    )
    const rejected = cap.events.find((event) => event.event === 'STATE_PROPOSAL_REJECTED')
    const pass =
      verdict.ok === false &&
      verdict.reason === 'stale-generation' &&
      result.ledgerRejected === 'stale-generation' &&
      rejected?.detail.reason === 'stale-generation' &&
      before.equals(readFileSync(statePath)) &&
      state.ledger?.counter === 1
    return { pass, detail: `verdict=${verdict.reason} commitReason=${result.ledgerRejected} bytesUnchanged=${before.equals(readFileSync(statePath))}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#5(c): an accepted proposal commits exactly once (world memory + ledger batched)', () => {
  const { dir, statePath } = withTempState()
  try {
    const memory = emptyWorldMemory()
    const state = snapshot(20, 'gen-now', memory)
    writeSnapshotAtomic(statePath, state)

    const pending = newPendingProposals()
    pending.generationId = 'gen-now'
    stageWorldMemory(pending, {
      craftingTables: [{ x: 9, y: 64, z: 9 }],
      discoveredOres: ['iron_ore'],
      moveFailures: [
        {
          key: 'overworld:9,64,9',
          dimension: 'overworld',
          x: 9,
          y: 64,
          z: 9,
          attempts: 3,
          firstFailedAt: 1,
          lastFailedAt: 2,
          lastReason: 'unreachable',
          blacklistedUntil: 30_000,
        },
      ],
    })
    stageLedgerProposal(pending, { ledger: ledger(3), baseRevision: 20, generationId: 'gen-now' })

    let saveCalls = 0
    const result = commitPendingProposals(
      {
        pending,
        memory,
        state,
        guard: { revision: 20, committedGenerationId: 'gen-now', activeGenerationId: 'gen-now' },
        log: capture().log,
        save: () => {
          saveCalls += 1
          bumpRevision(state)
          writeSnapshotAtomic(statePath, state)
          return durableWriteLanded('generation-start', state.revision)
        },
        writeLedgerMirror: () => undefined,
      },
      'generation-start',
    )

    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as AgentSnapshot
    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'))
    const pass =
      result.writes === 1 &&
      saveCalls === 1 &&
      result.worldMemoryDeltasApplied === 1 &&
      result.ledgerApplied &&
      state.revision === 21 &&
      parsed.revision === 21 &&
      parsed.ledger?.counter === 3 &&
      parsed.worldMemoryByKey[WORLD_KEY]?.craftingTables.length === 1 &&
      parsed.worldMemoryByKey[WORLD_KEY]?.discoveredOres.includes('iron_ore') === true &&
      parsed.worldMemoryByKey[WORLD_KEY]?.moveFailures[0]?.attempts === 3 &&
      leftovers.length === 0
    return { pass, detail: `writes=${result.writes} saveCalls=${saveCalls} revision=${parsed.revision} ledgerCounter=${parsed.ledger?.counter} tables=${parsed.worldMemoryByKey[WORLD_KEY]?.craftingTables.length} tmpLeftovers=${leftovers.length}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#5: a generation-path durable write is detected as DURABLE_WRITE_VIOLATION and blocked', () => {
  const { dir, statePath } = withTempState()
  try {
    writeSnapshotAtomic(statePath, snapshot(1, 'gen-old', emptyWorldMemory()))
    const before = readFileSync(statePath)
    const cap = capture()

    setStrictSpeculativeWrites(true)
    let threw = false
    try {
      guardedDurableWrite('speculative', 'generation-entry.ts:resolveLedgerPath', 'gen-test', cap.log, () => {
        writeSnapshotAtomic(statePath, snapshot(2, 'gen-test', emptyWorldMemory()))
      })
    } catch {
      threw = true
    }
    setStrictSpeculativeWrites(false)

    const violation = cap.events.find((event) => event.event === DURABLE_WRITE_VIOLATION)
    const blocked = before.equals(readFileSync(statePath))

    const allowed = guardedDurableWrite('host-commit', 'agent-runner.mts:commitPendingProposals', 'gen-old', cap.log, () => {
      writeSnapshotAtomic(statePath, snapshot(2, 'gen-old', emptyWorldMemory()))
    })
    const afterAllowed = JSON.parse(readFileSync(statePath, 'utf8')) as AgentSnapshot

    const pass =
      violation !== undefined &&
      violation.detail.site === 'generation-entry.ts:resolveLedgerPath' &&
      violation.detail.caller === 'gen-test' &&
      threw &&
      blocked &&
      allowed &&
      afterAllowed.revision === 2
    return { pass, detail: `marker=${violation?.event} site=${String(violation?.detail.site)} strictThrew=${threw} blocked=${blocked} hostCommitAllowed=${allowed}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

let failures = 0
process.stdout.write('speculative durable-write contract (#5)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} durable-write cases passed\n`)
if (failures > 0) process.exit(1)
