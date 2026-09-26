import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'bun:test'
import type { Bot } from 'mineflayer'
import { JevController, MIRRORED_MARKERS, mirroredEventToken } from './src/controller-legacy.ts'
import { jevAgent } from './src/index.ts'
import { ReachMissionRuntime } from './src/reach/mission-runtime.ts'
import type { ReachMissionRuntimeDependencies } from './src/reach/mission-runtime.ts'

const controller = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')
const reachPlane = readFileSync(new URL('./src/reach/controller-plane.ts', import.meta.url), 'utf8')
const stallObservers = readFileSync(new URL('./src/legacy/stall-observers.ts', import.meta.url), 'utf8').replace(/\bhost\./g, 'this.')
const indexSource = readFileSync(new URL('./src/index.ts', import.meta.url), 'utf8')
const runtimeAdapter = readFileSync(new URL('./src/minecraft/reach-runtime-adapter.ts', import.meta.url), 'utf8')
const minecraftReachProjection = readFileSync(new URL('./src/minecraft/reach-mission-projection.ts', import.meta.url), 'utf8')
const runtimePortsSource = readFileSync(new URL('./src/reach/ports.ts', import.meta.url), 'utf8')
const reachController = readFileSync(new URL('./src/reach/controller.ts', import.meta.url), 'utf8')
const reachMissionRuntime = readFileSync(new URL('./src/reach/mission-runtime.ts', import.meta.url), 'utf8')
const reachMissionProjection = readFileSync(new URL('./src/reach/mission-projection.ts', import.meta.url), 'utf8')
const jevRoutePolicy = readFileSync(new URL('./src/reach/route-policy.ts', import.meta.url), 'utf8')
const jevComposition = readFileSync(new URL('./src/reach/jev-composition.ts', import.meta.url), 'utf8')
const executor = readFileSync(new URL('./src/executor.ts', import.meta.url), 'utf8')
const generationEntry = readFileSync(new URL('../buddy-driver/generation-entry.ts', import.meta.url), 'utf8')

describe('VTR Reach production authority seam', () => {
  it('grounds production Reach routes from current world evidence before the persistent owner may use them', () => {
    assert.match(controller, /private initializeReachVtrRuntime\(\)/)
    assert.match(controller, /createJevReachVtrComposition\(/)
    assert.doesNotMatch(controller, /new ReachController\(nearestGroundedReachRoutePolicy\)/)
    assert.match(reachPlane, /host\.reachRuntime\.driveMission\(/)
    assert.match(reachMissionRuntime, /deriveInventoryReachTransition\(/)
    assert.match(reachMissionRuntime, /this\.deriveInventoryReachTransition\(/)
    assert.doesNotMatch(controller, /this\.reachRuntime\.commit\(contract, snapshot\)/)
    assert.doesNotMatch(controller, /snapshotForContract|startInventoryReach/)
    assert.doesNotMatch(controller, /createInventoryReachTransition\(/)
    assert.match(jevComposition, /policy: \(\) => context\.policy\.value/)
    assert.match(jevComposition, /cachedWorldState: JevReachMutableCell<WorldState \| null>/)
    assert.doesNotMatch(jevComposition, /from ['"]mineflayer['"]|\bBot\b|this\.bot/)

    assert.match(minecraftReachProjection, /generateGroundedCandidates\(world, input\.candidateOptions\)/)
    assert.match(minecraftReachProjection, /isMissionReachSourceCandidate\(/)
    assert.match(minecraftReachProjection, /projectReachMissionSnapshot\(/)
    assert.match(minecraftReachProjection, /reachMoveFitsLocomotionContract/)
    assert.match(reachMissionProjection, /export function projectReachMissionSnapshot\(/)
    assert.match(reachMissionProjection, /matchingSource\(input, route\)/)
    assert.match(reachMissionProjection, /'reach\.resource-source':\s*\{/)
    assert.match(reachMissionProjection, /predicates\[`reach\.route:\$\{route\.routeId\}`\] = \{ truth: 'true', evidenceId: route\.witness\.evidenceId \}/)
    assert.match(reachMissionProjection, /groundingPredicateId: `reach\.route:\$\{route\.routeId\}`/)
    assert.match(reachMissionProjection, /effectKind: 'locomotion'/)
    assert.match(reachMissionProjection, /resources: \{\}/)
    assert.match(reachMissionProjection, /risk: \{\}/)
    const backendNeutralProjection = reachMissionProjection.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '')
    assert.doesNotMatch(backendNeutralProjection, /from ['"][^'"]*(?:mineflayer|candidates|state)\.ts['"]|\bWorldState\b|\bCandidate\b|\bBlockState\b|\bEntityState\b/)

    const groundingStart = reachController.indexOf('function routeIsGrounded(')
    const groundingEnd = reachController.indexOf('\n}\n', groundingStart)
    const routeGrounding = reachController.slice(groundingStart, groundingEnd)
    const commitStart = reachController.indexOf('private async commitInternal(')
    const commitEnd = reachController.indexOf('/** Reconcile fresh facts', commitStart)
    const commit = reachController.slice(commitStart, commitEnd)
    assert.ok(groundingStart >= 0 && groundingEnd > groundingStart && commitEnd > commitStart)
    assert.match(routeGrounding, /grounding\?\.truth !== 'true'/)
    assert.match(routeGrounding, /grounding\.evidenceId !== witness\.evidenceId/)
    assert.match(routeGrounding, /contract\.controller\.allowedTactics\.includes\(route\.tactic\)/)
    assert.match(routeGrounding, /contract\.admissibleEffects\.some/)
    assert.match(routeGrounding, /sameIdentity\(witness\.observedIdentity, observation\.identity\)/)
    assert.match(routeGrounding, /amount > limit/)
    assert.match(commit, /this\.groundedRoutes\(contract, snapshot, null\)/)
    assert.match(commit, /this\.advance\(snapshot, true\)/)
  })

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

    const reachStart = reachPlane.indexOf('export async function tickReachTransition(')
    const reachEnd = reachPlane.indexOf('export function authorizeReachMechanicalStep(', reachStart)
    const reachTick = reachPlane.slice(reachStart, reachEnd)
    assert.match(reachTick, /host\.reachRuntime\.activeMission/)
    assert.match(reachTick, /host\.reachRuntime\.driveMission\(/)
    assert.doesNotMatch(reachTick, /host\.reachRuntime\.commit\(|host\.reachRuntime\.tick\(/)
    assert.match(reachTick, /decision\.reason === 'route-decision-required'/)
    assert.match(reachTick, /await host\.dispatchReachIntent\(/)
    assert.doesNotMatch(reachTick, /decideBeta|applyBeta/)
  })

  it('terminalizes a foreign VTR transition lease instead of treating it as this Reach owner', () => {
    const reachStart = reachPlane.indexOf('export async function tickReachTransition(')
    const reachEnd = reachPlane.indexOf('export function authorizeReachMechanicalStep(', reachStart)
    const reachTick = reachPlane.slice(reachStart, reachEnd)
    assert.ok(reachStart >= 0 && reachEnd > reachStart)
    assert.match(reachMissionRuntime, /frame\.activeAction\.authority !== 'vtr-reach' \|\| frame\.activeAction\.transitionId !== current\.contract\.transitionId/)
    assert.match(reachMissionRuntime, /this\.supersede\(/)
    assert.match(reachMissionRuntime, /session\.duplicateAuthorityObserved = true/)
    assert.match(reachTick, /activeAction: action/)
  })

  it('keeps raw-client reads out of VTR core and behind the allowlisted typed runtime adapter', () => {
    const backendFreeDirs = ['./src/vtr/', './src/reach/']
    for (const dir of backendFreeDirs) {
      const vtrFiles = readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      for (const entry of vtrFiles) {
        const source = readFileSync(new URL(`${dir}${entry.name}`, import.meta.url), 'utf8')
        assert.doesNotMatch(source, /from ['"]mineflayer['"]|\bBot\b|this\.bot/, `${entry.name} is VTR core and must stay backend independent`)
      }
    }
    assert.match(controller, /from ['"]\.\/minecraft\/reach-runtime-adapter\.ts['"]/)
    assert.match(runtimeAdapter, /import type \{ Bot \} from ['"]mineflayer['"]/, 'the dedicated Mineflayer adapter is the explicit Bot allowlist boundary')
    assert.match(runtimeAdapter, /return buildWorldState\(this\.bot, input, options\)/)
    assert.match(runtimeAdapter, /this\.bot\.pathfinder/)
    assert.match(runtimeAdapter, /this\.bot\.blockAt/)
    assert.match(runtimeAdapter, /this\.executor\.claim\(/)
    assert.doesNotMatch(runtimePortsSource, /\bBot\b|\bExecutor\b|Mineflayer/)
    const runtimePortsStart = runtimePortsSource.indexOf('export interface ReachRuntimePorts {')
    const runtimePortsEnd = runtimePortsSource.indexOf('\n}', runtimePortsStart)
    const runtimePorts = runtimePortsSource.slice(runtimePortsStart, runtimePortsEnd)
    assert.ok(runtimePortsStart >= 0 && runtimePortsEnd > runtimePortsStart)
    assert.doesNotMatch(runtimePorts, /\bBot\b|\bExecutor\b|Mineflayer/)

    const sensingStart = reachPlane.indexOf('export function buildReachWorldState(')
    const sensingEnd = reachPlane.indexOf('\nexport ', sensingStart + 1)
    const sensing = reachPlane.slice(sensingStart, sensingEnd)
    const dispatchStart = reachPlane.indexOf('export async function dispatchReachIntent(')
    const releaseStart = reachPlane.indexOf('export async function releaseUnstartedReachIntent(', dispatchStart)
    const reachStart = reachPlane.indexOf('export async function tickReachTransition(')
    const reachEnd = reachPlane.indexOf('export function authorizeReachMechanicalStep(', reachStart)
    assert.ok(sensingStart >= 0 && sensingEnd > sensingStart && dispatchStart >= 0 && releaseStart > dispatchStart && reachEnd > reachStart)
    const dispatch = reachPlane.slice(dispatchStart, releaseStart)
    const reachOrchestration = reachPlane.slice(reachStart, reachEnd)
    assert.match(sensing, /host\.reachRuntimeAdapter\.inventoryCounts\(\)/)
    assert.match(sensing, /host\.reachRuntimeAdapter\.containerContents\(\)/)
    assert.match(sensing, /host\.reachRuntimeAdapter\.observeWorldState\(/)
    assert.doesNotMatch(sensing, /(?:this|host)\.bot|(?:this|host)\.executor\b|buildWorldState\(/)
    assert.match(dispatch, /host\.reachRuntimeAdapter\.dispatch\(/)
    assert.doesNotMatch(dispatch, /(?:this|host)\.executor\.claim\(|guardCandidate\(/)
    assert.doesNotMatch(reachOrchestration, /(?:this|host)\.bot|(?:this|host)\.executor\.(?:claim|current|cancelCurrent)/)
    assert.match(reachOrchestration, /host\.projectReachMission\(/)
    assert.doesNotMatch(reachOrchestration, /generateGroundedCandidates|reachObservation\(|reachRuntimeSnapshot\(|reachWitnessForCandidate/)
    assert.match(reachOrchestration, /Mission scheduling\/session\/lifecycle[\s\S]*?ownership lives in the backend-independent ReachMissionRuntime/)
    assert.match(minecraftReachProjection, /Deletion condition:[\s\S]*?canonical Minecraft[\s\S]*?typed resource-source/)
    assert.match(reachOrchestration, /Delete this shim after Reach observation,[\s\S]*?exact-source evidence proves no legacy caller needs this entry point/)
    assert.doesNotMatch(jevRoutePolicy, /from ['"]mineflayer['"]|\bBot\b/)
    assert.match(jevRoutePolicy, /ReachRouteDecisionInput/)
    assert.match(jevRoutePolicy, /decisionFrame: \{/)
    assert.match(jevComposition, /createJevReachVtrComposition/)
    assert.match(reachMissionRuntime, /async driveMission\(/)
    assert.match(reachMissionRuntime, /Production Mission scheduler and lifecycle boundary[\s\S]*?adapter prepares[\s\S]*?typed facts\/routes/)
    assert.match(jevRoutePolicy, /input\.contract\.(desiredPredicate|budget|admissibleEffects|identity)/)
    assert.match(reachPlane, /selectedRoute: host\.reachRuntime\.current\?\.route/)
    assert.match(reachPlane, /probabilities: routeSelection\.probabilities/)
    assert.doesNotMatch(reachMissionRuntime, /from ['"]mineflayer['"]|\bBot\b/)
  })

  it('keeps the complete VTR tick prelude and Reach sensing helpers behind typed runtime facts', () => {
    const tickStart = controller.indexOf('private async tick(trigger: DecisionTrigger')
    const tickEnd = controller.indexOf('private jevLog(', tickStart)
    const reachDispatch = controller.indexOf('await this.tickReachTransition(trigger, detail)', tickStart)
    assert.ok(tickStart >= 0 && tickEnd > tickStart && reachDispatch > tickStart)
    const prelude = controller.slice(tickStart, reachDispatch)
    assert.doesNotMatch(prelude, /this\.bot|this\.currentDimension\(\)/)
    assert.match(prelude, /this\.reachRuntimeAdapter\.currentDimension\(\)/)
    assert.match(prelude, /this\.reachRuntimeAdapter\.currentHealth\(\)/)
    assert.match(prelude, /this\.reachRuntimeAdapter\.bodyAvailable\(\)/)

    const method = (name: string): string => {
      const cstart = controller.indexOf(`private ${name}(`)
      if (cstart >= 0) {
        const cend = controller.indexOf('\n  private ', cstart + 1)
        assert.ok(cend > cstart, `expected private helper ${name}`)
        return controller.slice(cstart, cend)
      }
      const pstart = Math.max(
        reachPlane.indexOf(`export function ${name}(`),
        reachPlane.indexOf(`export async function ${name}(`),
      )
      const pend = reachPlane.indexOf('\nexport ', pstart + 1)
      assert.ok(pstart >= 0 && pend > pstart, `expected helper ${name} in controller or Reach plane`)
      return reachPlane.slice(pstart, pend)
    }
    const typedObservationHelpers = [
      'buildReachWorldState',
      'mergeRememberedPortalFrame',
      'syncTerrainSignals',
      'observeThreat',
      'observeThreatState',
      'observeUnansweredRangedThreat',
      'observeEnvHazard',
      'projectReachMission',
      'reachIdentity',
      'liveReachIdentity',
    ]
    for (const name of typedObservationHelpers) {
      assert.doesNotMatch(method(name), /(?:this|host)\.bot|(?:this|host)\.currentDimension\(\)/, `${name} must consume typed observations only`)
    }
    assert.doesNotMatch(method('projectReachMission'), /generateGroundedCandidates|WorldState\.blocks|reach\.resource-source|reach\.waypoint/)
    assert.match(method('syncTerrainSignals') + stallObservers, /this\.bindDigMemoryScope\(state\.self\.dimension\)/)
    assert.doesNotMatch(method('syncTerrainSignals') + stallObservers, /this\.digMemory(?:\.|\s)/)
    assert.match(runtimeAdapter, /bodyAvailable\(\): boolean\s*\{\s*return this\.bot\.entity !== undefined/)
    assert.match(runtimeAdapter, /currentHealth\(\): number\s*\{\s*return this\.bot\.health \?\? 0/)
  })

  it('does not journal an admitted Transition when its initial Jev route choice is unresolved', () => {
    const start = reachMissionRuntime.indexOf('const plan = this.deriveInventoryReachTransition({')
    const commit = reachMissionRuntime.indexOf('const result = await this.commit(plan.contract, snapshot)', start)
    const notAdmitted = reachMissionRuntime.indexOf("if (result.status !== 'active' && result.status !== 'terminal')", commit)
    assert.ok(start >= 0 && commit > start && notAdmitted > commit)
    assert.doesNotMatch(controller, /const plan = this\.reachRuntime\.deriveInventoryReachTransition/)
  })

  it('makes the explicit Reach probe fail closed before any legacy recovery/model/Executor dispatch', () => {
    const tickStart = controller.indexOf('private async tick(trigger: DecisionTrigger')
    const tickEnd = controller.indexOf('private jevLog(', tickStart)
    const tick = controller.slice(tickStart, tickEnd)
    const dispatch = tick.indexOf('const handled = await this.tickReachTransition(trigger, detail)')
    const probeHold = tick.indexOf("this.options.vtrReachProbe === true", dispatch)
    const legacyRecovery = tick.indexOf('this.observeRetrievalStall()', dispatch)
    assert.ok(dispatch >= 0 && probeHold > dispatch && legacyRecovery > probeHold)
    assert.match(tick.slice(probeHold, legacyRecovery), /VTR_REACH_PROBE_HOLD/)
    assert.match(tick.slice(probeHold, legacyRecovery), /cancelCurrent\('VTR Reach probe refused legacy scheduler fallback'\)/)
    assert.match(tick.slice(probeHold, legacyRecovery), /return/)

    const entry = generationEntry.slice(generationEntry.indexOf('const vtrReachProbe ='))
    assert.match(entry, /const plannerMode = vtrReachProbe \? 'llm' : configuredPlannerMode/)
    assert.match(entry, /if \(vtrReachProbe\) \{[\s\S]*?ledgerRestore: 'disabled'/)
    assert.match(entry, /if \(vtrReachProbe\) \{[\s\S]*?restoredLegacyRows: 0/)
    assert.match(entry, /productionPlanAuthority: vtrReachProbe \? 'vtr-reach-probe'/)
  })

  it('maps the typed Reach intent through fresh candidate grounding, Guard, and the VTR Executor lease inside the adapter', () => {
    const dispatchStart = reachPlane.indexOf('export async function dispatchReachIntent(')
    const dispatchEnd = reachPlane.indexOf('export async function releaseUnstartedReachIntent(', dispatchStart)
    const dispatch = reachPlane.slice(dispatchStart, dispatchEnd)
    assert.match(dispatch, /host\.reachRuntimeAdapter\.dispatch\(/)
    assert.doesNotMatch(dispatch, /guardCandidate\(|this\.executor\.claim\(/)
    const locate = runtimeAdapter.indexOf('if (candidate.id !== intent.routeId)')
    const guard = runtimeAdapter.indexOf('const guard = guardCandidate(candidate, observation, {', locate)
    const claim = runtimeAdapter.indexOf('const claim = this.executor.claim(guard.candidate, {', guard)
    assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart && locate >= 0 && guard > locate && claim > guard)
    assert.match(dispatch, /result\.status !== 'active' \|\| result\.phase !== 'actuate' \|\| result\.intent === undefined/)
    assert.match(dispatch, /candidate = candidates\.find\(\(entry\) => entry\.id === intent\.routeId\)/)
    assert.match(dispatch, /host\.reachRuntimeAdapter\.reachabilityGateOptions\(host\.tickCounter, host\.reachabilityProofs\)/)
    assert.match(runtimeAdapter.slice(locate, guard), /candidate\.id !== intent\.routeId/)
    assert.match(runtimeAdapter.slice(locate, guard), /JSON\.stringify\(candidate\.target\) !== JSON\.stringify\(intent\.target\)/)
    assert.match(runtimeAdapter.slice(guard, claim), /phase: 'decision'/)
    assert.match(runtimeAdapter.slice(guard, claim), /candidateIds: new Set\(\[candidate\.id\]\)/)
    assert.match(runtimeAdapter.slice(guard, claim), /canComputePath: \(position\) => request\.reachability\.pathProbe/)
    assert.match(runtimeAdapter.slice(guard, claim), /if \(!guard\.ok\)/)
    assert.match(runtimeAdapter.slice(claim), /authority: 'vtr-reach'/)
    assert.match(runtimeAdapter.slice(claim), /transitionId: intent\.transitionId/)
    assert.match(runtimeAdapter.slice(claim), /transitionContractHash: intent\.contractHash/)
    assert.match(runtimeAdapter.slice(claim), /beforeMechanicalStep: request\.beforeMechanicalStep/)
    assert.match(runtimeAdapter.slice(claim), /afterMechanicalStep: request\.afterMechanicalStep/)
    assert.match(runtimeAdapter.slice(claim), /resolveVtrReachMechanicalWaypoint: \(destination\) => this\.resolveVtrReachMechanicalWaypoint\(destination\)/)
    assert.match(runtimeAdapter, /pathfinder\.getPathTo\(pathfinder\.movements, goal, REACH_PATH_SEGMENT_TIMEOUT_MS\)/)

    const activeActionStart = executor.indexOf('export interface CurrentAction')
    const activeActionEnd = executor.indexOf('export interface ExecutionClaimContext', activeActionStart)
    const claimStart = executor.indexOf('claim(candidate: Candidate', activeActionEnd)
    const claimEnd = executor.indexOf('get activeCommitment', claimStart)
    const activeAction = executor.slice(activeActionStart, activeActionEnd)
    const conflictGate = executor.slice(claimStart, claimEnd)
    assert.match(activeAction, /authority\?: 'legacy' \| 'vtr-reach'/)
    assert.match(activeAction, /transitionId\?: string/)
    assert.match(activeAction, /transitionContractHash\?: string/)
    assert.match(conflictGate, /running\.transitionContractHash !== context\.transitionContractHash/)
    assert.match(conflictGate, /actuation authority conflict/)
    assert.match(conflictGate, /throw new ExecutionAuthorityConflict/)
  })

  it('passes the typed mechanical outcome through without rebuilding or casting away runtime evidence', () => {
    const dispatchStart = reachPlane.indexOf('export async function dispatchReachIntent(')
    const dispatchEnd = reachPlane.indexOf('export async function releaseUnstartedReachIntent(', dispatchStart)
    const dispatch = reachPlane.slice(dispatchStart, dispatchEnd)
    const outcomeStart = reachPlane.indexOf('export async function onReachActionComplete(')
    const outcomeEnd = reachPlane.indexOf('export function closeReachTransition(', outcomeStart)
    const outcomeHandler = reachPlane.slice(outcomeStart, outcomeEnd)
    assert.match(runtimePortsSource, /completion: Promise<ReachMechanicalActionOutcome>/)
    assert.match(runtimePortsSource, /readonly (actionId|status|failure|verified|progressed):/)
    assert.match(runtimeAdapter, /claim,\s*actionId: this\.executor\.current\?\.id/)
    assert.match(dispatch, /\.then\(\(execution\) => host\.onReachActionComplete\(execution, guardedCandidate, intent\.transitionId, intent\.intentId\)\)/)
    assert.doesNotMatch(dispatch, /as ExecutionResult|Pick<ExecutionResult/)
    assert.match(outcomeHandler, /result: ReachMechanicalActionOutcome/)
    assert.match(outcomeHandler, /VTR_ORPHAN_ACTION_OUTCOME[\s\S]*?result \}, host\.tickCounter\)/)
    assert.match(outcomeHandler, /result\.failure[\s\S]*?result\.verified[\s\S]*?result\.progressed/)
  })

  it('reserves each mechanical leg before actuation, accounts its outcome, and never treats action success as Reach success', () => {
    const authorizeStart = reachPlane.indexOf('export function authorizeReachMechanicalStep(')
    const outcomeStart = reachPlane.indexOf('export function recordReachMechanicalOutcome(', authorizeStart)
    const actionCompleteStart = reachPlane.indexOf('export async function onReachActionComplete(', outcomeStart)
    const closeStart = reachPlane.indexOf('export function closeReachTransition(', actionCompleteStart)
    assert.ok(authorizeStart >= 0 && outcomeStart > authorizeStart && actionCompleteStart > outcomeStart && closeStart > actionCompleteStart)
    const authorize = reachPlane.slice(authorizeStart, outcomeStart)
    const mechanicalOutcome = reachPlane.slice(outcomeStart, actionCompleteStart)
    const completion = reachPlane.slice(actionCompleteStart, closeStart)
    assert.match(authorize, /host\.reachRuntime\.authorizeMechanicalStep\(/)
    assert.match(authorize, /host\.options\.actuationPort\?\.assertLease\(/)
    assert.match(authorize, /VTR_MECHANICAL_STEP_RESERVED/)
    assert.match(mechanicalOutcome, /host\.reachRuntime\.recordMechanicalStepOutcome\(/)
    assert.match(mechanicalOutcome, /step\.stepId/)
    assert.match(completion, /VTR_MECHANICAL_OUTCOME/)
    assert.match(completion, /await host\.reachRuntime\.complete\(intentId/)
    assert.match(completion, /status: result\.status === 'done' \? 'completed'/)
    assert.match(completion, /if \(completed\.status === 'terminal'\)/)
    assert.doesNotMatch(completion, /if \(result\.status === 'done'\)[\s\S]{0,80}closeReachTransition/)
    assert.match(reachPlane, /controller: contract\.controller/)
    assert.match(reachPlane, /progressDefinition: contract\.progressDefinition/)
    assert.match(reachPlane, /desiredPredicateIdentity: contract\.desiredPredicateIdentity/)
    assert.match(reachPlane, /ensuresIdentity: contract\.ensuresIdentity/)
  })

  it('records the controller typed terminal before handing scheduling back; no action completion asks legacy beta', () => {
    const completionStart = reachPlane.indexOf('export async function onReachActionComplete(')
    const closeStart = reachPlane.indexOf('export function closeReachTransition(', completionStart)
    const closeEnd = reachPlane.indexOf('export function logReachVerification', closeStart)
    const completion = reachPlane.slice(completionStart, closeStart)
    const close = reachPlane.slice(closeStart, closeEnd)
    assert.match(completion, /await host\.reachRuntime\.complete\(intentId/)
    assert.match(completion, /if \(completed\.status === 'terminal'\)/)
    assert.doesNotMatch(completion, /decideBeta|applyBeta/)
    assert.match(completion, /requestDecision\('action_completed'/)
    assert.match(close, /VTR_TRANSITION_OUTCOME/)
    assert.match(close, /typedTerminalOutcome: outcome\.kind/)
    assert.match(close, /verifiedTransitionCompletion: outcome\.kind === 'SUCCESS' \? 1 : 0/)
    assert.match(close, /mechanicalStepsPerTransition: state\.usage\.mechanicalSteps/)
    assert.match(close, /typedOutcome: outcome\.kind/)
    assert.match(close, /schedulerHandoff: true/)
    assert.match(close, /host\.reachRuntime\.takeTerminalHandoff\(\)/)
  })

  it('withholds same-Mission resource MOVE from the legacy decision plane while VTR owns Reach', () => {
    const ownerFilter = controller.indexOf('const legacyReachFilter = filterLegacyReachCandidates({')
    const filterEnd = controller.indexOf('candidates = this.applyFurnacePrereq', ownerFilter)
    assert.ok(ownerFilter >= 0 && filterEnd > ownerFilter)
    const suppression = controller.slice(ownerFilter, filterEnd)
    assert.match(suppression, /missionItem: vtrMission\.item/)
    assert.match(suppression, /missionSourceNames: minecraftMissionSourceNames\(vtrMission\.item\)/)
    assert.match(suppression, /candidates = legacyReachFilter\.candidates/)
    assert.match(suppression, /VTR_LEGACY_REACH_MOVE_WITHHELD/)

    const tickStart = controller.indexOf('private async tick(trigger: DecisionTrigger')
    const tickEnd = controller.indexOf('private jevLog(', tickStart)
    const tick = controller.slice(tickStart, tickEnd)
    assert.ok(tick.indexOf('filterLegacyReachCandidates({') < tick.indexOf('await this.decide(state, candidates'))

    const compatibility = minecraftReachProjection
    assert.match(compatibility, /Strangler boundary at the legacy candidate\/claim edge/)
    assert.match(compatibility, /Delete this filter[\s\S]*?legacy candidate\/claim path no longer owns[\s\S]*?Mission semantics/)
    assert.match(compatibility, /missionResourceSourceMatches\(item, sourceName, null, sourceNames\)/)
    assert.match(compatibility, /world\.blocks\.some\(/)

    assert.match(compatibility, /export function isMissionReachSourceCandidate\(/)

    const schedulerStart = reachPlane.indexOf('export async function tickReachTransition(')
    const schedulerEnd = reachPlane.indexOf('export function authorizeReachMechanicalStep(', schedulerStart)
    const scheduler = reachPlane.slice(schedulerStart, schedulerEnd)
    assert.match(scheduler, /isMissionReachWalkAction\(/)
    assert.match(scheduler, /const projection = host\.projectReachMission\(/)
    assert.match(scheduler, /host\.reachRuntime\.driveMission\(/)
  })

  it('requires KernelReachAuthority by construction at every production seam', () => {
    // Static shape: the gate is a required field, never an optional mode.
    assert.match(controller, /\n  kernelAuthority: KernelReachAuthority\n/)
    assert.doesNotMatch(controller, /kernelAuthority\?:|kernelAuthority: KernelReachAuthority \| (undefined|null)/)
    assert.match(controller, /options: Partial<JevAgentOptions> & Pick<JevAgentOptions, 'kernelAuthority'>/)
    assert.match(controller, /export type JevAgentOptionDefaults = Omit<JevAgentOptions, 'kernelAuthority'>/)
    assert.match(controller, /setOptions\(partial: Partial<Omit<JevAgentOptions, 'kernelAuthority'>>/)
    assert.match(jevComposition, /readonly kernelAuthority: KernelReachAuthority/)
    assert.doesNotMatch(jevComposition, /kernelAuthority\?:|kernelAuthority === null|kernelAuthority \?\?/)
    assert.match(reachMissionRuntime, /private readonly kernelAuthority: KernelReachAuthority/)
    // The only authority-absent branch left is the fail-closed constructor
    // throw; no `if (authority) vtr else legacy` fork exists anywhere.
    assert.match(reachMissionRuntime, /throw new Error\('ReachMissionRuntime requires KernelReachAuthority'\)/)
    assert.doesNotMatch(reachMissionRuntime, /kernelAuthority\?\.|kernelAuthority \?\?/)
    assert.match(indexSource, /export function jevAgent\(bot: Bot, kernelAuthority: KernelReachAuthority\): void/)
    // Production generation hardcodes authority mode and throws when the
    // session cannot produce the gate — miswiring can never silently select
    // an observer-only or legacy Reach path.
    assert.match(generationEntry, /const kernelAuthorityMode = 'authority' as const/)
    assert.match(generationEntry, /if \(kernelAuthority === null\) \{\s*throw new Error\('V4\.1\.2 kernel authority session did not produce the production gate'\)/)

    // Runtime level: even an authority-less construction forced past the
    // types throws closed instead of running Reach without an owner.
    assert.throws(
      () => new ReachMissionRuntime({ kernelAuthority: undefined } as unknown as ReachMissionRuntimeDependencies),
      /requires KernelReachAuthority/,
    )
  })
})

// Compile-time proof: these constructions must keep failing typecheck. The
// function is never invoked — `bun x tsc --noEmit` is the gate.
function authorityRequiredAtTypeLevel(): void {
  const bot = null as unknown as Bot
  // @ts-expect-error JevController construction requires the kernelAuthority pick
  void new JevController(bot)
  // @ts-expect-error an options literal without kernelAuthority is rejected
  void new JevController(bot, {})
  // @ts-expect-error the plugin entry requires the host-owned gate
  jevAgent(bot)
  const missingGate = {} as Omit<ReachMissionRuntimeDependencies, 'kernelAuthority'>
  // @ts-expect-error ReachMissionRuntime dependencies require kernelAuthority
  void new ReachMissionRuntime(missingGate)
}
void authorityRequiredAtTypeLevel
