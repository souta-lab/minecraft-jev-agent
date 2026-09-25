const SECRET_KEY = /(api.?key|authorization|cookie|password|secret|token)/i
const HEARTBEAT_FRESHNESS_MS = 15_000
const MAX_PROGRESS_SAMPLES = 64
const MAX_MECHANICAL_LEGS = 64
const MAX_EVIDENCE_EVENTS = 24

function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'string') {
    return value
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
      .replace(/((?:api.?key|authorization|cookie|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, nested]) => [key, redact(nested)]))
  }
  return value
}

function parseTime(value) {
  const time = Date.parse(value ?? '')
  return Number.isFinite(time) ? time : null
}

function normalizeDimension(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  return value.includes(':') ? value : `minecraft:${value}`
}

function normalizeWorldKey(key) {
  if (typeof key === 'string') {
    const parts = key.split('|')
    if (parts.length !== 3 || parts[0] === '' || parts[1] === '') return null
    const worldEpoch = Number(parts[2])
    return Number.isSafeInteger(worldEpoch)
      ? { serverId: parts[0], dimension: normalizeDimension(parts[1]), worldEpoch }
      : null
  }
  if (key === null || typeof key !== 'object' || Array.isArray(key)) return null
  return {
    serverId: key.serverId ?? null,
    dimension: normalizeDimension(key.dimension),
    worldEpoch: key.worldEpoch ?? null,
  }
}

function isCompleteWorldKey(value) {
  const worldKey = normalizeWorldKey(value)
  return worldKey !== null
    && typeof worldKey.serverId === 'string' && worldKey.serverId.length > 0
    && typeof worldKey.dimension === 'string' && worldKey.dimension.length > 0
    && Number.isSafeInteger(worldKey.worldEpoch)
}

function sameWorldKey(left, right) {
  const a = normalizeWorldKey(left)
  const b = normalizeWorldKey(right)
  return a !== null && b !== null
    && a.serverId === b.serverId
    && a.dimension === b.dimension
    && a.worldEpoch === b.worldEpoch
}

function eventAge(event, nowMs) {
  const observedAt = typeof event?.ts === 'string' ? event.ts : null
  const time = parseTime(observedAt)
  if (time === null) return { status: 'unknown', observedAt, ageMs: null }
  if (time > nowMs) return { status: 'future_timestamp', observedAt, ageMs: null }
  return { status: 'observed', observedAt, ageMs: nowMs - time }
}

function projectProgress(transition, nowMs) {
  const raw = Array.isArray(transition?.progressHistory) ? transition.progressHistory : []
  const history = raw.slice(-MAX_PROGRESS_SAMPLES).map((sample) => ({
    observedAt: typeof sample?.observedAt === 'string' ? sample.observedAt : null,
    sequence: Number.isSafeInteger(sample?.sequence) && sample.sequence >= 0 ? sample.sequence : null,
    latestPredicateDistance: typeof sample?.latestPredicateDistance === 'number'
      && Number.isFinite(sample.latestPredicateDistance) && sample.latestPredicateDistance >= 0
      ? sample.latestPredicateDistance : null,
    bestPredicateDistance: typeof sample?.bestPredicateDistance === 'number'
      && Number.isFinite(sample.bestPredicateDistance) && sample.bestPredicateDistance >= 0
      ? sample.bestPredicateDistance : null,
    reachability: ['reachable', 'unreachable', 'unknown'].includes(sample?.reachability) ? sample.reachability : 'unknown',
    frontierId: typeof sample?.frontierId === 'string' ? sample.frontierId : null,
    evidenceId: typeof sample?.evidenceId === 'string' ? sample.evidenceId : null,
  }))
  const latest = history.at(-1) ?? null
  const latestAt = parseTime(latest?.observedAt)
  const latestFreshness = latest === null
    ? { status: 'unknown', observedAt: null, ageMs: null }
    : eventAge({ ts: latest.observedAt }, nowMs)
  const monotonicSequence = history.length >= 2 && history.every((sample, index) => index === 0
    || (sample.sequence !== null && history[index - 1].sequence !== null && sample.sequence > history[index - 1].sequence))
  const hasBestDistances = history.length >= 2 && history.every((sample) => sample.bestPredicateDistance !== null)
  const bestDistanceMonotonic = hasBestDistances && monotonicSequence && history.every((sample, index) => index === 0
    || sample.bestPredicateDistance <= history[index - 1].bestPredicateDistance)
  const latestBest = latest?.bestPredicateDistance ?? null
  let unchangedSince = null
  if (hasBestDistances && bestDistanceMonotonic && monotonicSequence && latestAt !== null) {
    let firstLatestBest = history.length - 1
    while (firstLatestBest > 0 && history[firstLatestBest - 1].bestPredicateDistance === latestBest) firstLatestBest -= 1
    unchangedSince = history[firstLatestBest].observedAt
  }
  const unchangedSinceMs = parseTime(unchangedSince)
  const unchangedAgeMs = unchangedSinceMs !== null && unchangedSinceMs <= nowMs
    ? nowMs - unchangedSinceMs
    : null
  let lastBestChangeAt = null
  if (bestDistanceMonotonic) {
    for (let index = 1; index < history.length; index += 1) {
      if (history[index].bestPredicateDistance < history[index - 1].bestPredicateDistance) {
        lastBestChangeAt = history[index].observedAt
      }
    }
  }
  let progressStatus = 'unknown'
  if (history.length >= 2 && !monotonicSequence) progressStatus = 'inconsistent_sequence'
  else if (history.length >= 2 && !hasBestDistances) progressStatus = 'best_distance_unknown'
  else if (history.length >= 2 && !bestDistanceMonotonic) progressStatus = 'inconsistent_best_distance'
  else if (history.length >= 2 && latest !== null) {
    const previous = history.at(-2)
    progressStatus = latest.bestPredicateDistance < previous.bestPredicateDistance
      ? 'best_distance_improved'
      : 'no_new_best_observed'
  }
  return {
    status: history.length === 0 ? 'unknown' : 'observed',
    measure: transition?.contract?.progressDefinition?.measure ?? 'predicate_distance',
    progressDefinition: transition?.contract?.progressDefinition ?? null,
    latest,
    latestObservedAt: latest?.observedAt ?? null,
    latestAgeMs: latestFreshness.ageMs,
    bestPredicateDistance: latestBest,
    reachability: latest?.reachability ?? 'unknown',
    evidenceId: latest?.evidenceId ?? null,
    observationSequence: latest?.sequence ?? null,
    history,
    historyTruncated: raw.length > MAX_PROGRESS_SAMPLES || transition?.progressHistoryTruncated === true,
    trendStatus: progressStatus,
    lastBestChangeAt,
    unchangedSince: unchangedAgeMs === null ? null : unchangedSince,
    unchangedAgeMs,
    stall: {
      status: progressStatus === 'no_new_best_observed'
        ? 'no_new_best_observed'
        : progressStatus === 'best_distance_improved'
          ? 'best_distance_improved'
          : 'unknown',
      measure: 'best_predicate_distance',
      since: unchangedAgeMs === null ? null : unchangedSince,
      unchangedAgeMs,
      thresholdApplied: false,
    },
  }
}

function projectMechanicalLegs(mechanical) {
  const rawSteps = Array.isArray(mechanical?.steps) ? mechanical.steps : []
  const legs = rawSteps.slice(-MAX_MECHANICAL_LEGS).map((step) => {
    const actuationEvents = Array.isArray(step?.actuations) ? step.actuations : []
    const latestActuation = actuationEvents.at(-1)?.event ?? null
    const actuationDetail = latestActuation?.detail ?? {}
    const outcomeDetail = step?.stepOutcome ?? null
    return {
      stepId: step?.stepId ?? null,
      leg: step?.leg ?? null,
      intentId: step?.intentId ?? null,
      status: step?.status ?? 'unknown',
      candidate: actuationDetail.candidate ?? null,
      target: actuationDetail.target ?? null,
      authority: actuationDetail.authority ?? actuationDetail.selectedBy ?? null,
      reservedAt: step?.reserved?.ts ?? null,
      actuatedAt: latestActuation?.ts ?? null,
      outcomeAt: step?.outcome?.ts ?? null,
      settlement: outcomeDetail === null ? 'not_observed'
        : outcomeDetail.status === 'terminal' ? 'terminal'
          : 'active',
      outcome: outcomeDetail?.outcome ?? null,
      verified: typeof outcomeDetail?.verified === 'boolean' ? outcomeDetail.verified : null,
      reason: outcomeDetail?.reason ?? null,
      contractHash: outcomeDetail?.contractHash ?? null,
      evidenceIdentity: outcomeDetail?.identity ?? null,
    }
  })
  const settledCount = legs.filter((leg) => leg.settlement === 'terminal').length
  const refusedCount = legs.filter((leg) => leg.status === 'control_event_observed').length
  return {
    status: rawSteps.length === 0 ? 'not_recorded' : 'observed',
    legCount: mechanical?.reservationCount ?? rawSteps.length,
    settledCount,
    activeCount: legs.filter((leg) => leg.settlement === 'active').length,
    unobservedCount: legs.filter((leg) => leg.settlement === 'not_observed').length,
    refusedCount,
    truncated: rawSteps.length > MAX_MECHANICAL_LEGS || mechanical?.truncated === true,
    legs,
  }
}

function projectTransition(snapshot, nowMs) {
  const source = snapshot?.vtr?.latest
  if (source === null || source === undefined) return null
  const verification = source.verification ?? null
  const verifyEvent = verification?.event ?? null
  const outcome = source.outcome ?? null
  const outcomeEvent = outcome?.event ?? null
  const owner = {
    authority: 'VTR',
    status: outcome === null ? 'committed' : 'terminal',
    sourceEvent: 'VTR_TRANSITION_COMMIT',
    committedAt: source.committedAt ?? null,
    controller: source.actuation?.authority ?? source.actuation?.selectedBy ?? null,
    controllerObservedAt: source.actuation?.event?.ts ?? null,
  }
  const route = source.routeDecision ?? null
  const offeredRoutes = Array.isArray(route?.routeIds)
    ? route.routeIds.filter((routeId) => typeof routeId === 'string').slice(0, 64)
    : []
  const evidenceEvents = [
    { ts: source.committedAt, event: 'VTR_TRANSITION_COMMIT' },
    route,
    source.progressEvent,
    verifyEvent,
    outcomeEvent,
  ].filter(Boolean).map((event) => ({
    observedAt: event.ts ?? null,
    event: event.event ?? null,
    transitionId: source.transitionId,
    contractHash: source.contractHash,
  }))
  const freshness = {
    asOf: new Date(nowMs).toISOString(),
    commit: eventAge({ ts: source.committedAt }, nowMs),
    latestProgress: eventAge(source.progressEvent, nowMs),
    verification: eventAge(verifyEvent, nowMs),
    outcome: eventAge(outcomeEvent, nowMs),
  }
  return {
    id: source.transitionId ?? null,
    transitionId: source.transitionId ?? null,
    contractHash: source.contractHash ?? null,
    status: source.status ?? 'unknown',
    owner,
    mission: source.mission ?? null,
    desiredPredicate: source.desiredPredicate ?? null,
    contract: source.contract ?? null,
    routingDecision: route === null ? null : {
      actor: route.actor ?? 'unknown',
      source: route.source ?? null,
      policy: route.policy ?? null,
      model: route.model ?? null,
      callId: route.callId ?? null,
      routeId: route.selectedRoute?.routeId ?? null,
      grounded: route.selectedRoute?.grounded ?? false,
      offeredRouteIds: offeredRoutes,
      offeredRoutesTruncated: route?.routeIdsTruncated === true,
      probabilities: route?.probabilities ?? null,
      probabilitiesTruncated: route?.probabilitiesTruncated === true,
      selectedProbability: route?.actionProbability ?? null,
      latencyMs: route?.latencyMs ?? null,
      observedAt: route.observedAt ?? null,
      reason: route.reason ?? null,
      binding: route.binding ?? null,
    },
    progress: projectProgress(source, nowMs),
    mechanical: projectMechanicalLegs(source.mechanical),
    verification: verification === null ? {
      status: 'not_recorded',
      truth: null,
      verified: false,
      predicates: [],
      evidenceIds: [],
      observedAt: null,
      ageMs: null,
    } : {
      status: verification.verified === true ? 'verified'
        : verification.truth === 'TRUE' ? 'true_but_not_verified'
          : verification.truth ?? 'unknown',
      truth: verification.truth ?? null,
      verified: verification.verified === true,
      predicates: Array.isArray(verification.predicates) ? verification.predicates : [],
      evidenceIds: Array.isArray(verification.evidenceIds) ? verification.evidenceIds : [],
      observedAt: verifyEvent?.ts ?? null,
      verifiedAtMs: verification.verifiedAtMs ?? null,
      ageMs: freshness.verification.ageMs,
      identity: verification.binding ?? null,
    },
    outcome: outcome === null ? {
      status: 'pending',
      kind: null,
      reason: null,
      boundary: null,
      usage: null,
      metrics: source.modelMetrics ?? null,
      evidenceIds: [],
      observedAt: null,
      ageMs: null,
    } : {
      status: source.status === 'verified_success' ? 'verified_success' : 'terminal',
      kind: outcome.kind ?? null,
      reason: outcome.reason ?? outcome.typed?.reason ?? null,
      boundary: outcome.boundary ?? null,
      usage: outcome.usage ?? null,
      metrics: outcome.metrics ?? source.modelMetrics ?? null,
      evidenceIds: Array.isArray(outcome.typed?.evidenceIds) ? outcome.typed.evidenceIds : [],
      observedAt: outcome.event?.ts ?? null,
      ageMs: freshness.outcome.ageMs,
    },
    evidence: {
      freshness,
      events: evidenceEvents,
      outcomeConsistency: source.outcomeConsistency ?? null,
      metricsConsistency: source.modelMetricsConsistency ?? null,
      binding: source.binding ?? null,
    },
  }
}

/**
 * Build the one VTR-native observer contract shared by the human dashboard,
 * /api/ai-summary and its probe-runner readiness checks.
 */
export function buildVtrObserverReadModel(snapshot, { now = Date.now(), currentWorldProbe = null } = {}) {
  const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  const sourceRun = snapshot?.resident ?? {}
  const vtr = snapshot?.vtr ?? null
  const vtrBinding = vtr?.binding ?? null
  const worldKeyMatches = sameWorldKey(vtrBinding?.worldKey, sourceRun.worldKey)
  const boundIdentity = vtr?.binding?.confidence === 'direct'
    && typeof vtrBinding.runId === 'string' && vtrBinding.runId.length > 0
    && vtrBinding.runId === sourceRun.runId
    && typeof vtrBinding.generationId === 'string' && vtrBinding.generationId.length > 0
    && vtrBinding.generationId === sourceRun.generationId
    && typeof vtrBinding.sourceSha === 'string' && /^[0-9a-f]{40}$/i.test(vtrBinding.sourceSha)
    && vtrBinding.sourceSha === sourceRun.sourceCommit
    && isCompleteWorldKey(vtrBinding.worldKey)
    && isCompleteWorldKey(sourceRun.worldKey)
    && worldKeyMatches
  const run = {
    id: sourceRun.runId ?? null,
    sourceCommit: sourceRun.sourceCommit ?? null,
    sourceCommitBinding: sourceRun.sourceCommitBinding ?? 'unknown',
    generationId: sourceRun.generationId ?? null,
    generationBoundary: sourceRun.generationBoundary ?? null,
    generationHash: sourceRun.generationHash ?? null,
    worldKey: sourceRun.worldKey ?? null,
  }
  const mission = snapshot?.mission?.status === 'observed'
    ? {
      status: 'observed',
      id: snapshot.mission.id ?? null,
      title: snapshot.mission.title ?? null,
      predicate: snapshot.mission.predicate ?? null,
      provenance: snapshot.mission.provenance ?? null,
      binding: boundIdentity ? {
        runId: run.id,
        generationId: run.generationId,
        sourceCommit: run.sourceCommit,
        worldKey: run.worldKey,
      } : null,
    }
    : {
      status: 'unknown',
      id: null,
      title: null,
      predicate: null,
      provenance: snapshot?.mission?.provenance ?? null,
      binding: null,
    }
  const heartbeat = [...(Array.isArray(snapshot?.events) ? snapshot.events : [])]
    .reverse().find((event) => event.event === 'HEARTBEAT') ?? null
  const heartbeatFreshness = eventAge(heartbeat, nowMs)
  const heartbeatLive = sourceRun.available === true && sourceRun.connected === true
    && heartbeatFreshness.ageMs !== null && heartbeatFreshness.ageMs <= HEARTBEAT_FRESHNESS_MS
  const heartbeatDetail = heartbeat?.detail ?? {}
  const observedAtMs = parseTime(snapshot?.observedAt)
  const freshnessMs = observedAtMs === null || observedAtMs > nowMs ? null : nowMs - observedAtMs
  const transition = boundIdentity ? projectTransition(snapshot, nowMs) : null
  const currentProbe = currentWorldProbe === null ? null : bindProbe(currentWorldProbe, run)
  const unknown = []
  if (!sourceRun.available) unknown.push('resident_report_unavailable')
  if (run.id === null) unknown.push('live_run_identity_unavailable')
  if (!boundIdentity) unknown.push(vtr?.unknown?.[0] ?? 'vtr_run_generation_source_world_boundary_unavailable')
  if (mission.status !== 'observed') unknown.push(mission.provenance?.reason ?? 'mission_authority_unavailable')
  if (transition === null) unknown.push(vtr?.unknown?.[0] ?? 'no_vtr_transition_commit_in_bounded_run_tail')
  if (transition?.progress.status === 'unknown' || transition?.progress.trendStatus === 'unknown') {
    unknown.push('vtr_transition_progress_unavailable_or_insufficient_history')
  }
  if (transition?.verification.status === 'not_recorded' || transition?.verification.truth !== 'TRUE') {
    unknown.push('vtr_deterministic_verification_not_true')
  }
  if (transition?.outcome.status === 'pending') unknown.push('vtr_typed_terminal_outcome_not_recorded')
  if (heartbeatLive !== true) unknown.push('world_heartbeat_stale_or_missing')
  const modelAvailability = sourceRun.modelAvailability ?? null
  const modelUnavailable = modelAvailability?.state === 'degraded'
  if (modelUnavailable) unknown.push('model_authority_unavailable')
  const headline = transition === null
    ? mission.status === 'observed'
      ? `Mission ${mission.id ?? mission.title} observed; no committed VTR Transition is present in the bounded journal.`
      : 'Mission and committed VTR Transition are unknown.'
    : `VTR owns Transition ${transition.id} for ${transition.desiredPredicate?.id ?? 'unknown predicate'}; VERIFY=${transition.verification.truth ?? 'UNKNOWN'}, outcome=${transition.outcome.kind ?? 'pending'}.`
  const worldObservation = heartbeat === null ? null : {
    observedAt: heartbeat.ts,
    ageMs: heartbeatFreshness.ageMs,
    sourceEvent: heartbeat.event,
    live: heartbeatLive,
    worldKey: run.worldKey,
    dimension: snapshot?.truth?.dimension ?? run.worldKey?.dimension ?? null,
    position: snapshot?.truth?.position ?? null,
    health: snapshot?.truth?.health ?? heartbeatDetail.health ?? null,
    food: snapshot?.truth?.food ?? heartbeatDetail.food ?? null,
    inventory: snapshot?.truth?.inventory ?? heartbeatDetail.inv ?? null,
  }
  return redact({
    schema: 'ai-buddy-vtr-observer/v1',
    kind: 'verified-transition-read-model',
    readOnly: true,
    observedAt: new Date(nowMs).toISOString(),
    freshnessMs,
    headline,
    status: {
      available: sourceRun.available === true && sourceRun.connected === true && !modelUnavailable,
      hostAvailable: sourceRun.available === true,
      connected: sourceRun.connected === true,
      frozen: sourceRun.frozen ?? null,
      availabilityReason: modelUnavailable ? 'MODEL_UNAVAILABLE' : sourceRun.available ? null : snapshot?.runtimeFailure?.detail?.code ?? null,
    },
    run,
    mission,
    transition,
    vtr: {
      status: vtr?.status ?? 'unknown',
      binding: vtr?.binding ?? null,
    },
    worldObservation,
    world: {
      status: snapshot?.truth === null || snapshot?.truth === undefined ? 'unknown' : 'observed',
      truth: snapshot?.truth ?? null,
      heartbeat: heartbeat === null ? null : {
        ...heartbeat,
        ageMs: heartbeatFreshness.ageMs,
        live: heartbeatLive,
      },
      currentProbe,
    },
    unknown,
    interpretation: 'Only exact-generation VTR journal evidence is projected. Missing evidence remains unknown; distance change reports semantic predicate progress and never uses body motion alone.',
  })
}

function bindProbe(probe, run) {
  const binding = probe?.binding ?? null
  const summaryWorld = normalizeWorldKey(run.worldKey)
  const probeWorld = normalizeWorldKey(binding?.probeWorld)
  const sameRun = typeof run.id === 'string' && typeof binding?.probeRunId === 'string'
    ? run.id === binding.probeRunId : null
  const sameWorld = summaryWorld !== null && probeWorld !== null
    ? summaryWorld.serverId === probeWorld.serverId
      && summaryWorld.dimension === probeWorld.dimension
      && summaryWorld.worldEpoch === probeWorld.worldEpoch
    : null
  const sameGeneration = typeof run.generationId === 'string' && typeof binding?.probeGenerationId === 'string'
    ? run.generationId === binding.probeGenerationId : null
  const status = sameRun === true && sameWorld === true && sameGeneration === true
    ? 'aligned'
    : [sameRun, sameWorld, sameGeneration].includes(false) ? 'mismatch' : 'unknown'
  return {
    ...probe,
    summaryBinding: {
      status, sameRun, sameWorld, sameGeneration,
      summary: { runId: run.id, generationId: run.generationId, worldKey: summaryWorld },
      probe: { runId: binding?.probeRunId ?? null, generationId: binding?.probeGenerationId ?? null, worldKey: probeWorld },
    },
  }
}

export function renderVtrObserverHtml() {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Buddy — 検証済み遷移</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #0b0e13; color: #e7edf5; }
    header { position: sticky; top:0; z-index:2; display:flex; gap:16px; align-items:center; justify-content:space-between; padding:16px 22px; background:#10151dcc; backdrop-filter:blur(12px); border-bottom:1px solid #263041; }
    h1 { font-size:18px; margin:0; }
    .status { display:flex; gap:10px; align-items:center; color:#9fafc2; font-size:13px; }
    .dot { width:9px; height:9px; border-radius:99px; background:#687587; }
    .dot.online { background:#50d890; box-shadow:0 0 0 4px #50d89022; }
    main { max-width:1450px; margin:0 auto; padding:22px; }
    .flow { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-bottom:14px; }
    .flow-card,.card { min-width:0; background:#121821; border:1px solid #263041; border-radius:14px; padding:14px; }
    .eyebrow { color:#73839a; font-size:11px; letter-spacing:.12em; text-transform:uppercase; margin-bottom:8px; }
    .primary { font-size:15px; font-weight:650; overflow-wrap:anywhere; }
    .secondary { margin-top:7px; color:#9fafc2; font-size:12px; overflow-wrap:anywhere; }
    .grid { display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); gap:14px; }
    .card { grid-column:span 4; }
    .card.wide { grid-column:span 8; }
    .card.full { grid-column:1/-1; }
    h2 { margin:0 0 12px; font-size:15px; }
    dl { display:grid; grid-template-columns:minmax(110px,.8fr) 2fr; gap:7px 12px; margin:0; font-size:13px; }
    dt { color:#73839a; }
    dd { margin:0; overflow-wrap:anywhere; }
    .trace { display:grid; gap:9px; }
    .trace-row { border-left:2px solid #39485d; padding:8px 10px; background:#0e131a; border-radius:0 8px 8px 0; }
    .trace-head { display:flex; justify-content:space-between; gap:12px; margin-bottom:6px; }
    .trace-event { font-weight:650; font-size:12px; }
    .trace-time { color:#65748a; font-size:11px; white-space:nowrap; }
    .trace-detail { color:#afbdcf; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
    .empty { color:#65748a; font-size:13px; }
    @media (max-width:900px) { .flow { grid-template-columns:1fr 1fr; } .card,.card.wide { grid-column:1/-1; } }
    @media (max-width:560px) { main { padding:12px; } header { padding:13px 14px; } .flow { grid-template-columns:1fr; } }
  </style>
</head>
<body>
<header><h1>AI Buddy · 検証済み遷移</h1><div class="status"><span id="dot" class="dot"></span><span id="resident">不明</span><span id="updated">—</span></div></header>
<main>
  <section class="flow">
    <div class="flow-card"><div class="eyebrow">ミッション</div><div id="flow-mission" class="primary">不明</div><div id="flow-mission-sub" class="secondary"></div></div>
    <div class="flow-card"><div class="eyebrow">遷移</div><div id="flow-transition" class="primary">不明</div><div id="flow-transition-sub" class="secondary"></div></div>
    <div class="flow-card"><div class="eyebrow">所有者 / 経路</div><div id="flow-owner" class="primary">不明</div><div id="flow-owner-sub" class="secondary"></div></div>
    <div class="flow-card"><div class="eyebrow">検証 / 結果</div><div id="flow-terminal" class="primary">不明</div><div id="flow-terminal-sub" class="secondary"></div></div>
  </section>
  <section class="grid">
    <article class="card"><h2>実行環境の識別</h2><dl id="identity"></dl></article>
    <article class="card wide"><h2>遷移契約</h2><dl id="contract"></dl></article>
    <article class="card wide"><h2>目標条件に対する進捗</h2><dl id="progress"></dl></article>
    <article class="card"><h2>実行した機械的ステップ</h2><dl id="legs"></dl></article>
    <article class="card wide"><h2>決定的検証 / 型付き結果</h2><dl id="verification"></dl></article>
    <article class="card"><h2>証拠の鮮度</h2><dl id="freshness"></dl></article>
    <article class="card"><h2>現在のワールド観測</h2><dl id="world"></dl></article>
    <article class="card full"><h2>遷移の証拠</h2><div id="trace" class="trace"></div></article>
    <article class="card full"><h2>不明 / 未確認の項目</h2><dl id="unknown"></dl></article>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id)
  const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
  const text = (value, fallback = '不明') => value === null || value === undefined || value === '' ? fallback : typeof value === 'string' ? value : JSON.stringify(value)
  const statusLabel = (value) => ({
    unknown:'不明', not_recorded:'未記録', pending:'処理中', active_or_pending:'実行中',
    verified:'検証済み', verified_success:'検証済み成功', terminal:'終了',
    active:'実行中', not_observed:'未観測', true:'はい', false:'いいえ',
    one_sample:'サンプル不足', best_distance_unknown:'最良距離が不明',
    inconsistent_sequence:'系列が不整合', inconsistent_best_distance:'最良距離が不整合',
    best_distance_improved:'最良距離を更新', no_new_best_observed:'観測履歴内で最良距離の更新なし',
    TRUE:'成立', FALSE:'未成立', CONTINUING:'継続', SUCCESS:'成功',
  }[value] ?? text(value))
  const unknownLabel = (value) => ({
    resident_report_unavailable:'resident report を取得できていません',
    live_run_identity_unavailable:'現在の run ID を確認できていません',
    vtr_run_generation_source_world_boundary_unavailable:'run / generation / source / world の境界証拠が不足しています',
    no_vtr_transition_commit_in_bounded_run_tail:'記録範囲内に VTR Transition の commit がありません',
    vtr_transition_progress_unavailable_or_insufficient_history:'predicate 進捗の履歴が不足しています',
    vtr_deterministic_verification_not_true:'deterministic VERIFY が TRUE ではありません',
    vtr_typed_terminal_outcome_not_recorded:'型付き終了結果が記録されていません',
    world_heartbeat_stale_or_missing:'world heartbeat が古いか未記録です',
    model_authority_unavailable:'model decision plane が利用できません',
  }[value] ?? value)
  const rows = (node, entries) => { node.innerHTML = entries.map(([key,value]) => '<dt>'+esc(key)+'</dt><dd>'+esc(text(value))+'</dd>').join('') }
  const eventRow = (entry) => {
    const detail = {event:entry.event, observedAt:entry.observedAt, transitionId:entry.transitionId, contractHash:entry.contractHash}
    return '<div class="trace-row"><div class="trace-head"><span class="trace-event">'+esc(entry.event || '証拠')+'</span><span class="trace-time">'+esc(entry.observedAt || '')+'</span></div><div class="trace-detail">'+esc(JSON.stringify(detail, null, 2))+'</div></div>'
  }
  function render(model) {
    if (model.schema !== 'ai-buddy-vtr-observer/v1') return
    const transition = model.transition
    $('dot').className = 'dot' + (model.status.available && model.status.connected ? ' online' : '')
    $('resident').textContent = model.status.available ? '接続中' : model.status.hostAvailable ? '切断または方策利用不可' : 'resident 利用不可'
    $('updated').textContent = new Date(model.observedAt).toLocaleTimeString()
    $('flow-mission').textContent = model.mission.status === 'observed' ? text(model.mission.title, text(model.mission.id)) : '不明'
    $('flow-mission-sub').textContent = text(model.mission.id, '') + (model.mission.predicate ? ' · ' + text(model.mission.predicate) : '')
    $('flow-transition').textContent = transition ? text(transition.id) : 'コミット済み遷移なし'
    $('flow-transition-sub').textContent = transition ? text(transition.desiredPredicate?.id, statusLabel(transition.status)) + ' · 契約 ' + text(transition.contractHash) : 'VTR journal の証拠なし'
    $('flow-owner').textContent = transition ? text(transition.owner.authority) + ' が契約を所有' : '不明'
    const routing = transition?.routingDecision
    const offered = routing?.offeredRouteIds?.map(routeId => {
      const probability = routing.probabilities?.[routeId]
      return routeId + ' (' + (typeof probability === 'number' ? probability.toFixed(2) : '?') + ')'
    }).join(', ')
    $('flow-owner-sub').textContent = transition
      ? 'controller=' + text(transition.owner.controller) + ' · 選択経路=' + text(routing?.routeId) + ' · policy=' + text(routing?.actor) + ' · 候補=' + text(offered)
      : ''
    const terminal = transition?.outcome
    const terminalLabel = terminal?.kind === 'SUCCESS' && terminal.status !== 'verified_success'
      ? '成功の型付き結果 / VERIFY未確認'
      : statusLabel(terminal?.kind)
    $('flow-terminal').textContent = transition ? terminalLabel : '不明'
    $('flow-terminal-sub').textContent = transition ? 'VERIFY=' + statusLabel(transition.verification.truth) + ' · 検証済み=' + statusLabel(transition.verification.verified) : ''
    rows($('identity'), [
      ['ソース commit', model.run.sourceCommit], ['commit の結合根拠', model.run.sourceCommitBinding],
      ['run ID', model.run.id], ['generation ID', model.run.generationId],
      ['worldKey', model.run.worldKey], ['generation READY 時刻', model.run.generationBoundary?.observedAt],
    ])
    rows($('contract'), [
      ['達成する predicate', transition?.desiredPredicate], ['必要条件', transition?.contract?.requires],
      ['成立させる条件', transition?.contract?.ensures], ['維持条件', transition?.contract?.invariants],
      ['許容された効果', transition?.contract?.admissibleEffects], ['資源 / リスク予算', transition?.contract?.budget],
      ['証人 / 対象', transition?.contract?.witness], ['進捗の定義', transition?.contract?.progressDefinition],
    ])
    rows($('progress'), [
      ['状態', statusLabel(transition?.progress?.trendStatus)], ['最新 predicate distance', transition?.progress?.latest?.latestPredicateDistance],
      ['最良 predicate distance', transition?.progress?.bestPredicateDistance], ['観測 sequence', transition?.progress?.observationSequence],
      ['到達可能性', transition?.progress?.reachability], ['証拠 ID', transition?.progress?.evidenceId],
      ['最良値が変わった時刻', transition?.progress?.lastBestChangeAt],
      ['最良値が変わらない時間 (ms)', transition?.progress?.unchangedAgeMs],
      ['履歴サンプル数', transition?.progress?.history?.length],
      ['選択された経路', transition?.routingDecision?.routeId],
      ['候補経路', transition?.routingDecision?.offeredRouteIds],
      ['候補ごとの確率', transition?.routingDecision?.probabilities],
      ['選択経路の確率', transition?.routingDecision?.selectedProbability],
    ])
    rows($('legs'), [
      ['観測数', transition?.mechanical?.legCount], ['完了確認済み数', transition?.mechanical?.settledCount],
      ['実行中', transition?.mechanical?.activeCount], ['結果待ち', transition?.mechanical?.unobservedCount],
      ['拒否数', transition?.mechanical?.refusedCount],
      ['各ステップ', transition?.mechanical?.legs?.map(leg => ({leg:leg.leg,stepId:leg.stepId,candidate:leg.candidate,authority:leg.authority,settlement:statusLabel(leg.settlement),outcome:statusLabel(leg.outcome)}))],
    ])
    rows($('verification'), [
      ['検証状態', statusLabel(transition?.verification?.status)], ['真偽', statusLabel(transition?.verification?.truth)],
      ['検証済み', statusLabel(transition?.verification?.verified)], ['predicate', transition?.verification?.predicates],
      ['証拠 IDs', transition?.verification?.evidenceIds], ['VERIFY 時刻', transition?.verification?.observedAt],
      ['型付き結果', statusLabel(transition?.outcome?.kind)], ['結果状態', statusLabel(transition?.outcome?.status)],
      ['終了理由', transition?.outcome?.reason],
      ['終了証拠 IDs', transition?.outcome?.evidenceIds],
    ])
    rows($('freshness'), [
      ['読み取り結果の経過時間 (ms)', model.freshnessMs],
      ['進捗観測からの経過時間 (ms)', transition?.progress?.latestAgeMs],
      ['VERIFY からの経過時間 (ms)', transition?.verification?.ageMs],
      ['結果記録からの経過時間 (ms)', transition?.outcome?.ageMs],
      ['heartbeat からの経過時間 (ms)', model.world.heartbeat?.ageMs],
      ['heartbeat が新鮮か', statusLabel(model.world.heartbeat?.live)],
    ])
    rows($('world'), [
      ['観測済み事実', model.world.truth], ['heartbeat', model.world.heartbeat],
      ['現在probeとrunの一致', statusLabel(model.world.currentProbe?.summaryBinding?.status)],
    ])
    rows($('unknown'), [['未確認の理由', model.unknown.map(unknownLabel)]])
    $('trace').innerHTML = transition?.evidence?.events?.length
      ? transition.evidence.events.map(eventRow).join('')
      : '<div class="empty">遷移の証拠はまだ記録されていません。</div>'
  }
  async function fallback() { try { render(await fetch('/api/vtr-view', {cache:'no-store'}).then(response => response.json())) } catch {} }
  const stream = new EventSource('/events')
  stream.onmessage = event => { try { render(JSON.parse(event.data)) } catch {} }
  stream.onerror = fallback
  fallback()
</script>
</body>
</html>`
}
