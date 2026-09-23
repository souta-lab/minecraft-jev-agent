import { expect, test } from 'bun:test'
import { JevController } from './src/controller-legacy.ts'
import type { CurrentAction, ExecutionResult } from './src/executor.ts'
import type { SkillCommitment } from './src/skillCommitment.ts'

interface Fixture {
  controller: JevController
  current: CurrentAction
  currentAction: () => CurrentAction | null
  resolveAction: (result: ExecutionResult) => void
  cancelAttempts: () => number
  events: string[]
}

function makeFixture(startedAt = Date.now()): Fixture {
  let resolveAction: (result: ExecutionResult) => void = () => undefined
  const completion = new Promise<ExecutionResult>((resolve) => {
    resolveAction = resolve
  })
  const id = 'RETREAT:p108_63_92'
  const commitment = {
    commitmentId: 'retreat-commitment-1',
    candidateId: id,
    skillKind: 'retreat',
    budget: { ms: 15_000 },
  } as unknown as SkillCommitment
  const current: CurrentAction = {
    id,
    kind: 'RETREAT',
    epoch: 1,
    startedAt,
    phase: 'retreating',
    status: 'running',
    detail: '',
    completion,
    commitment,
  }
  let active: CurrentAction | null = current
  let cancels = 0
  const events: string[] = []
  const controller = Object.create(JevController.prototype) as JevController
  const state = controller as unknown as Record<string, any>
  let resolveRun: (summary: never) => void = () => undefined
  const runCompletion = new Promise<never>((resolve) => {
    resolveRun = resolve
  })
  Object.assign(state, {
    running: true,
    modelRecoveryStopping: false,
    modelRecoveryDrainTimer: null,
    tickCounter: 1,
    watchdog: null,
    completion: runCompletion,
    resolveCompletion: resolveRun,
    pendingDecisions: new Map(),
    decisionWriter: { write: () => undefined },
    saveLedger: () => undefined,
    clearDecisionTimer: () => undefined,
    runSuccess: () => false,
    summary: (stopped: string, success: boolean) => ({ stopped, success }),
    scheduler: { stop: () => undefined },
    bot: { removeListener: () => undefined },
    logger: {
      warn: (_source: string, line: string) => events.push(line),
      error: (_source: string, line: string) => events.push(line),
      info: (_source: string, line: string) => events.push(line),
    },
    executor: {
      get current() { return active },
      cancelCurrent: () => {
        if (active?.status !== 'running') return false
        cancels += 1
        active.status = 'cancelled'
        active = null
        return true
      },
    },
  })

  return {
    controller,
    current,
    currentAction: () => active,
    resolveAction,
    cancelAttempts: () => cancels,
    events,
  }
}

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('watchdog finish is deferred until a model-recovery RETREAT reaches its terminal boundary', async () => {
  const fixture = makeFixture()
  fixture.controller.stopForModelRecovery()
  const finish = (JevController.prototype as unknown as {
    finish(this: JevController, stopped: string, success: boolean): void
  }).finish

  finish.call(fixture.controller, 'max-runtime', false)
  expect(fixture.currentAction()?.status).toBe('running')
  expect(fixture.cancelAttempts()).toBe(0)
  expect(fixture.events.some((line) => line.includes('phase=finish_deferred') && line.includes('requestedReason=max-runtime'))).toBe(true)

  fixture.current.status = 'done'
  expect(fixture.currentAction()).toBe(fixture.current)
  fixture.resolveAction({ status: 'done', failure: null } as ExecutionResult)
  const result = await fixture.controller.wait()
  expect(result.stopped).toBe('stopped-by-caller')
  expect(fixture.cancelAttempts()).toBe(0)
  expect(fixture.events.some((line) => line.includes('phase=terminal') && line.includes('RETREAT:p108_63_92'))).toBe(true)
})

test('HOST quiesce waits through recovery drain, while ordinary quiesce outside recovery still cancels immediately', async () => {
  const draining = makeFixture()
  draining.controller.stopForModelRecovery()
  let quiesced = false
  const quiesce = draining.controller.quiesce().then(() => { quiesced = true })

  await settle()
  expect(quiesced).toBe(false)
  expect(draining.currentAction()?.status).toBe('running')
  expect(draining.cancelAttempts()).toBe(0)

  draining.current.status = 'done'
  draining.resolveAction({ status: 'done', failure: null } as ExecutionResult)
  await quiesce
  expect(quiesced).toBe(true)
  expect(draining.cancelAttempts()).toBe(0)

  const ordinary = makeFixture()
  await ordinary.controller.quiesce()
  expect(ordinary.currentAction()).toBe(null)
  expect(ordinary.current.status).toBe('cancelled')
  expect(ordinary.cancelAttempts()).toBe(1)
})

test('an over-budget recovery drain has an explicit cancellation terminal boundary', async () => {
  const fixture = makeFixture(Date.now() - 60_000)
  fixture.controller.stopForModelRecovery()
  const result = await fixture.controller.wait()
  expect(result.stopped).toBe('stopped-by-caller')
  expect(fixture.currentAction()).toBe(null)
  expect(fixture.cancelAttempts()).toBe(1)
  expect(fixture.events.some((line) => line.includes('phase=deadline') && line.includes('over-budget Skill'))).toBe(true)
})
