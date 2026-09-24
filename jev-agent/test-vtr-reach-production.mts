import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'bun:test'
import { MIRRORED_MARKERS, mirroredEventToken } from './src/controller-legacy.ts'

const controller = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')
const executor = readFileSync(new URL('./src/executor.ts', import.meta.url), 'utf8')
const generationEntry = readFileSync(new URL('../buddy-driver/generation-entry.ts', import.meta.url), 'utf8')

describe('VTR Reach production authority seam', () => {
  it('mirrors every Reach runtime event into the HOST event sink', () => {
    const markers = new Set([...controller.matchAll(/\b(VTR_[A-Z0-9_]+)\b/g)].map((match) => match[1]!))
    assert.ok(markers.size > 0, 'expected VTR event markers in the production controller')

    for (const marker of markers) {
      assert.ok(MIRRORED_MARKERS.has(marker), `${marker} must be registered for HOST mirroring`)
      assert.equal(mirroredEventToken(`${marker} transitionId=t1 contractHash=h1`), marker)
    }

    const loggerStart = controller.indexOf('class MirroringEventLogger')
    const loggerEnd = controller.indexOf('\n}\n', loggerStart)
    const mirror = controller.slice(loggerStart, loggerEnd)
    assert.match(mirror, /const token = mirroredEventToken\(message\)/)
    assert.match(mirror, /if \(token !== null\) this\.sink\(token, detail\)/)

    const hostEventSink = generationEntry.slice(generationEntry.indexOf('eventSink: (event, detail) => {'))
    assert.match(hostEventSink, /ctx\.log\(event, bindGenerationEventIdentity\(detail,\s*\{[\s\S]*?runId: ctx\.runId \?\? null,[\s\S]*?generationId: id,[\s\S]*?sourceSha: ctx\.sourceSha \?\? null,[\s\S]*?buildHash: ctx\.buildHash \?\? null,/)
  })

  it('dispatches the active Reach owner before legacy queue/model control and consumes its tick', () => {
    const tickStart = controller.indexOf('private async tick(trigger: DecisionTrigger')
    const tickEnd = controller.indexOf('private jevLog(', tickStart)
    assert.ok(tickStart >= 0 && tickEnd > tickStart)
    const tick = controller.slice(tickStart, tickEnd)
    const reachDispatch = tick.indexOf('await this.tickReachTransition(trigger, detail)')
    const consume = tick.indexOf('if (handled) return', reachDispatch)
    const legacyRecovery = tick.indexOf('this.observeRetrievalStall()', reachDispatch)
    const queueAuthority = tick.indexOf('this.syncQueue(trigger)', reachDispatch)
    assert.ok(reachDispatch >= 0 && consume > reachDispatch)
    assert.ok(legacyRecovery > consume && queueAuthority > consume)
  })

  it('binds every VTR body action to its transition and reserves/records each mechanical leg', () => {
    const claimStart = controller.indexOf("const claim = this.executor.claim(guard.candidate, {", controller.indexOf('private async tickReachTransition'))
    const claimEnd = controller.indexOf('})', claimStart)
    const claim = controller.slice(claimStart, claimEnd)
    assert.match(claim, /authority: 'vtr-reach'/)
    assert.match(claim, /transitionId,/)
    assert.match(claim, /beforeMechanicalStep:/)
    assert.match(claim, /afterMechanicalStep:/)

    const activeAction = executor.slice(executor.indexOf('export interface CurrentAction'), executor.indexOf('export interface ExecutionClaimContext'))
    const conflictGate = executor.slice(executor.indexOf('claim(candidate: Candidate'), executor.indexOf('get activeCommitment'))
    assert.match(activeAction, /authority\?: 'legacy' \| 'vtr-reach'/)
    assert.match(activeAction, /transitionId\?: string/)
    assert.match(conflictGate, /actuation authority conflict/)
    assert.match(conflictGate, /throw new ExecutionAuthorityConflict/)
  })

  it('charges observed world risk before the declared ensures predicate may verify', () => {
    const tickReachStart = controller.indexOf('private async tickReachTransition(')
    const tickReachEnd = controller.indexOf('private reachWitnessForCandidateShape(', tickReachStart)
    const tickReach = controller.slice(tickReachStart, tickReachEnd)
    const observedRisk = tickReach.indexOf('recordReachObservedRisk(runtime.contract, runtime.state, identity')
    const verify = tickReach.indexOf('verifyReachEnsures(runtime.contract, runtime.state, observation)')
    assert.ok(observedRisk >= 0 && verify > observedRisk)
  })

  it('records typed outcomes before a fresh scheduler handoff; no action completion asks legacy beta', () => {
    const completionStart = controller.indexOf('private onReachActionComplete(')
    const closeStart = controller.indexOf('private closeReachTransition(', completionStart)
    const closeEnd = controller.indexOf('// -------------------------------------------------------------------------\n  // the one loop', closeStart)
    const completion = controller.slice(completionStart, closeStart)
    const close = controller.slice(closeStart, closeEnd)
    assert.doesNotMatch(completion, /onActionComplete|decideBeta|applyBeta/)
    assert.match(completion, /requestDecision\('action_completed'/)
    assert.match(close, /VTR_TRANSITION_OUTCOME/)
    assert.match(close, /typedOutcome: outcome\.kind/)
    assert.match(close, /schedulerHandoff: true/)
  })

  it('keeps the old mission-source MOVE candidate out only on a tick where VTR owns that predicate', () => {
    const ownerFilter = controller.indexOf('if (this.vtrOwnsReachMoveThisTick && vtrMission !== null')
    const filterEnd = controller.indexOf('candidates = this.applyFurnacePrereq', ownerFilter)
    assert.ok(ownerFilter >= 0 && filterEnd > ownerFilter)
    assert.match(controller.slice(ownerFilter, filterEnd), /VTR_LEGACY_REACH_MOVE_WITHHELD/)
    assert.match(controller, /this\.vtrOwnsReachMoveThisTick = true/)
  })
})
