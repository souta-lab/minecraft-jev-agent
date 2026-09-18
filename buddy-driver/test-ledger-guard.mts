// test-ledger-guard.mts - issue #48: the ledger revision/identity guard on every
// write path. Pure: no bot, no network, no live host.
//
// Models the HOST commit loop (snapshot + ledgerRevision + bump-on-persist) so the
// three acceptance behaviours are exercised exactly as the resident uses them:
//   (a) a stale proposal is rejected and the store is unchanged
//   (b) an in-order proposal is accepted and increments the revision
//   (c) concurrent/out-of-order proposals cannot corrupt the snapshot
import type { GoalQueueSnapshot, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import type { AgentSnapshot, LedgerProposal } from './resident-types.ts'
import { emptyAgentSnapshot, bumpRevision } from './state-snapshot.ts'
import { commitLedgerProposal, evaluateLedgerProposal } from './ledger-guard.ts'

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
  return {
    events,
    log: (event, detail) => events.push({ event, detail: detail ?? {} }),
  }
}

function goal(id: string, description: string): QueuedGoal {
  return {
    id,
    kind: 'collect',
    description,
    targetItem: 'raw_iron',
    requiredCount: 3,
    targetY: null,
    dimension: null,
    startCount: 0,
    haveCount: 0,
    status: 'pending',
    origin: 'llm',
    createdAt: 1,
    updatedAt: 2,
    detail: null,
  }
}

function ledger(counter: number, marker: string): GoalQueueSnapshot {
  return { counter, goals: [goal(`g${counter}:collect:${marker}`, `collect ${marker}`)] }
}

/** Mirrors the resident HOST: the snapshot is authoritative, `ledgerRevision`
 * tracks the last accepted ledger commit, and `persist` bumps the revision. */
class HostStore {
  snapshot: AgentSnapshot
  ledgerRevision: number

  constructor(generationId: string | null, revision: number, base: GoalQueueSnapshot | null) {
    this.snapshot = emptyAgentSnapshot({ generationId, revision })
    this.snapshot.ledger = base
    this.ledgerRevision = revision
  }

  get revision(): number {
    return this.snapshot.revision
  }

  get ledger(): GoalQueueSnapshot | null {
    return this.snapshot.ledger
  }

  /** HOST-initiated sample (heartbeat): sole-writer, never advances the lineage. */
  hostCommit(next: GoalQueueSnapshot): void {
    this.snapshot.ledger = next
    bumpRevision(this.snapshot)
  }

  propose(raw: unknown, allowedGeneration: string | null, cap: Captured): boolean {
    const decision = commitLedgerProposal(
      this.snapshot,
      raw,
      { revision: this.snapshot.revision, ledgerRevision: this.ledgerRevision, generationId: allowedGeneration },
      cap.log,
      () => {
        bumpRevision(this.snapshot)
      },
      'test',
    )
    if (decision.ok) this.ledgerRevision = this.snapshot.revision
    return decision.ok
  }
}

addCase('#48a: a delayed proposal from a superseded generation is rejected and the store is unchanged', () => {
  const store = new HostStore('gen-B', 7, ledger(7, 'B-current'))
  const beforeRevision = store.revision
  const beforeLedger = store.ledger
  const cap = capture()
  const staleA: LedgerProposal = { generationId: 'gen-A', baseRevision: 3, ledger: ledger(3, 'A-stale') }
  const accepted = store.propose(staleA, 'gen-B', cap)
  const rejected = cap.events.find((event) => event.event === 'LEDGER_PROPOSAL_REJECTED')
  const pass =
    accepted === false &&
    store.revision === beforeRevision &&
    store.ledger === beforeLedger &&
    store.ledger?.counter === 7 &&
    rejected !== undefined &&
    rejected.detail.reason === 'stale' &&
    rejected.detail.revision === 3 &&
    rejected.detail.current === 7
  return { pass, detail: `accepted=${accepted} rev=${store.revision} ledger=${store.ledger?.counter} log=${JSON.stringify(rejected?.detail ?? null)}` }
})

addCase('#48b: an in-order proposal from the committed generation is accepted and bumps the revision', () => {
  const store = new HostStore('gen-A', 3, ledger(3, 'A-old'))
  const cap = capture()
  const next: LedgerProposal = { generationId: 'gen-A', baseRevision: 3, ledger: ledger(4, 'A-new') }
  const accepted = store.propose(next, 'gen-A', cap)
  const rejected = cap.events.find((event) => event.event === 'LEDGER_PROPOSAL_REJECTED')
  const pass =
    accepted === true &&
    rejected === undefined &&
    store.revision === 4 &&
    store.ledgerRevision === 4 &&
    store.ledger?.counter === 4 &&
    store.ledger?.goals[0]?.id === 'g4:collect:A-new'
  return { pass, detail: `accepted=${accepted} rev=${store.revision} ledgerRevision=${store.ledgerRevision} ledger=${store.ledger?.counter} rejects=${cap.events.filter((e) => e.event === 'LEDGER_PROPOSAL_REJECTED').length}` }
})

addCase('#48c: concurrent / out-of-order proposals cannot corrupt the snapshot', () => {
  const store = new HostStore('gen-B', 10, ledger(10, 'B-current'))
  const cap = capture()
  // 1) delayed stale A, then a duplicate of its own already-committed flush
  const staleA = store.propose({ generationId: 'gen-A', baseRevision: 2, ledger: ledger(2, 'A-stale') }, 'gen-B', cap)
  // 2) a future / impossible revision from the current generation
  const future = store.propose({ generationId: 'gen-B', baseRevision: 99, ledger: ledger(99, 'B-future') }, 'gen-B', cap)
  // 3) an out-of-order repeat of the already-committed B ledger
  const duplicate = store.propose({ generationId: 'gen-B', baseRevision: 5, ledger: ledger(5, 'B-dup') }, 'gen-B', cap)
  const afterRejectsRevision = store.revision
  const afterRejectsLedger = store.ledger
  // 4) a genuinely in-order proposal is still accepted afterwards
  const inOrder = store.propose({ generationId: 'gen-B', baseRevision: 10, ledger: ledger(11, 'B-inorder') }, 'gen-B', cap)
  const rejects = cap.events.filter((event) => event.event === 'LEDGER_PROPOSAL_REJECTED')
  const pass =
    staleA === false &&
    future === false &&
    duplicate === false &&
    inOrder === true &&
    afterRejectsRevision === 10 &&
    afterRejectsLedger?.counter === 10 &&
    store.revision === 11 &&
    store.ledger?.counter === 11 &&
    rejects.length === 3 &&
    rejects.every((event) => event.detail.reason === 'stale' || event.detail.reason === 'future-revision')
  return { pass, detail: `staleA=${staleA} future=${future} duplicate=${duplicate} inOrder=${inOrder} rejects=${rejects.length} rev=${store.revision} ledger=${store.ledger?.counter}` }
})

addCase('#48: a proposal that omits generationId/baseRevision is rejected (no silent bypass)', () => {
  const store = new HostStore('gen-A', 4, ledger(4, 'A-current'))
  const cap = capture()
  const bare = store.propose(ledger(5, 'bare'), 'gen-A', cap)
  const noId = store.propose({ baseRevision: 4, ledger: ledger(6, 'no-id') }, 'gen-A', cap)
  const invalid = cap.events.filter((event) => event.event === 'LEDGER_PROPOSAL_REJECTED' && event.detail.reason === 'invalid-proposal')
  const pass = bare === false && noId === false && invalid.length === 2 && store.revision === 4 && store.ledger?.counter === 4
  return { pass, detail: `bare=${bare} noId=${noId} invalid=${invalid.length} rev=${store.revision} ledger=${store.ledger?.counter}` }
})

addCase('#48: a HOST heartbeat sample never invalidates the live generation lineage', () => {
  const store = new HostStore('gen-A', 4, ledger(4, 'A-current'))
  store.hostCommit(ledger(5, 'heartbeat'))
  const lineageAfterHeartbeat = store.ledgerRevision
  const cap = capture()
  const accepted = store.propose({ generationId: 'gen-A', baseRevision: 4, ledger: ledger(6, 'A-final') }, 'gen-A', cap)
  const pass = lineageAfterHeartbeat === 4 && accepted === true && store.ledger?.counter === 6
  return { pass, detail: `lineageAfterHeartbeat=${lineageAfterHeartbeat} accepted=${accepted} ledger=${store.ledger?.counter}` }
})

addCase('#48: a superseded generation whose identity is reused in lineage is still rejected by revision', () => {
  // Defends the revision half of the guard independently of the identity half.
  const cap = capture()
  const decision = evaluateLedgerProposal(
    { generationId: 'gen-A', baseRevision: 3, ledger: ledger(3, 'A') },
    { revision: 12, ledgerRevision: 9, generationId: 'gen-A' },
  )
  const pass = decision.ok === false && decision.reason === 'stale' && decision.stale === 'revision' && decision.revision === 3 && decision.current === 9
  return { pass, detail: `ok=${decision.ok} reason=${decision.ok ? '-' : decision.reason} stale=${decision.ok ? '-' : decision.stale} log=${JSON.stringify(cap.events)}` }
})

let failures = 0
process.stdout.write('ledger proposal revision guard (#48)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} ledger-guard cases passed\n`)
if (failures > 0) process.exit(1)
