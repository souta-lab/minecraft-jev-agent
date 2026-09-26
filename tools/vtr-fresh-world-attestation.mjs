import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function timestamp(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
function loopbackPortFromWorldKey(value) {
  const serverId = typeof value === 'string' ? value.split('|', 1)[0] : value?.serverId
  const match = /^127\.0\.0\.1:(\d{1,5})$/u.exec(String(serverId ?? ''))
  if (!match) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}
function worldKeyString(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.serverId === 'string' && typeof value.dimension === 'string' && Number.isSafeInteger(value.worldEpoch)) {
    return `${value.serverId}|${value.dimension}|${value.worldEpoch}`
  }
  return null
}

export function inspectFreshWorldAttestation({ copiedSources, identity, run, serverStart, expectedWitnessRegionPath, lifecycle }) {
  const result = { status: 'INCOMPLETE', reason: null, sourceSha: identity.sourceSha, runId: identity.runId, artifacts: [] }
  const incomplete = (reason) => { result.status = 'INCOMPLETE'; result.reason = reason; return result }
  const fail = (reason) => { result.status = 'FAIL'; result.reason = reason; return result }
  const source = copiedSources.get('server/fresh-world-attestation.json')
  if (!source) return incomplete('server/fresh-world-attestation.json is absent')
  let attestation
  try { attestation = JSON.parse(source.bytes.toString('utf8')) }
  catch (error) { return fail(`fresh-world attestation is malformed JSON: ${error.message}`) }
  if (attestation?.schema !== 'vtr-fresh-world-attestation/v1') return fail('fresh-world attestation schema is not vtr-fresh-world-attestation/v1')

  const expectedServerId = identity.worldIdentity?.serverId
  const expectedPort = loopbackPortFromWorldKey(identity.worldKey)
  const expectedIdentity = { sourceSha: identity.sourceSha, runId: identity.runId, serverId: expectedServerId, port: expectedPort, levelName: run?.levelName }
  for (const [key, expected] of Object.entries(expectedIdentity)) {
    if (expected === null || expected === undefined || expected === '') return incomplete(`run identity for fresh-world ${key} is unavailable`)
    if (attestation[key] === undefined || attestation[key] === null) return incomplete(`fresh-world attestation ${key} is missing`)
    const observed = key === 'sourceSha' ? String(attestation[key]).toLowerCase() : attestation[key]
    if (observed !== expected) return fail(`fresh-world attestation ${key} differs from exact run identity`)
  }
  if (!Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535 || !/^127\.0\.0\.1:\d+$/u.test(String(expectedServerId))) {
    return incomplete('run world identity is not an exact loopback host and port')
  }
  const expectedWorldKey = worldKeyString(identity.worldKey)
  for (const [key, expected] of Object.entries({ sourceSha: identity.sourceSha, runId: identity.runId,
    generationId: identity.generationId, worldKey: expectedWorldKey })) {
    if (serverStart?.[key] === undefined || serverStart?.[key] === null) return incomplete(`server-start ${key} is missing for exact world identity`)
    const observed = key === 'sourceSha' ? String(serverStart[key]).toLowerCase() : serverStart[key]
    if (observed !== expected) return fail(`server-start ${key} differs from exact source/run/world identity`)
  }
  const server = attestation.server
  const preStart = attestation.preStartObservation
  const worldRoot = attestation.worldRoot
  if (!server || !preStart || !worldRoot) return incomplete('fresh-world server, pre-start, or world-root observation is absent')
  const preStartIdentity = { sourceSha: identity.sourceSha, runId: identity.runId, serverPid: server.pid,
    serverId: expectedServerId, port: expectedPort, levelName: run.levelName }
  for (const [key, expected] of Object.entries(preStartIdentity)) {
    if (expected === null || expected === undefined || expected === '') return incomplete(`pre-start expected ${key} identity is unavailable`)
    if (preStart[key] === undefined || preStart[key] === null) return incomplete(`pre-start world observation ${key} is missing`)
    const observed = key === 'sourceSha' ? String(preStart[key]).toLowerCase() : preStart[key]
    if (observed !== expected) return fail(`pre-start world observation ${key} differs from spawned Leaf identity`)
  }

  const serverStopped = lifecycle?.events?.serverStopped
  if (!serverStopped) return incomplete('identity-bound HOST server-stopped event is unavailable')
  if (worldRoot.archivePath !== 'server/world' || typeof worldRoot.absolute !== 'string' || !isAbsolute(worldRoot.absolute) ||
      typeof worldRoot.attemptRoot !== 'string' || !isAbsolute(worldRoot.attemptRoot)) {
    return incomplete('fresh-world root must bind an absolute attempt root, absolute world path, and canonical archive path')
  }
  const rootRelative = relative(resolve(worldRoot.attemptRoot), resolve(worldRoot.absolute))
  if (!rootRelative || rootRelative === '.' || rootRelative === '..' || rootRelative.startsWith(`..${sep}`) || isAbsolute(rootRelative)) {
    return fail('fresh-world path is not a strict child of the unique attempt root')
  }
  if (worldRoot.uniqueForRun !== identity.runId || preStart.path !== worldRoot.absolute) {
    return fail('pre-start absence evidence is not bound to this run-unique worldRoot')
  }
  if (!Number.isSafeInteger(server.pid) || server.pid <= 0 || serverStart?.pid === undefined || serverStart?.pid === null) {
    return incomplete('fresh-world server PID or server-start PID is missing')
  }
  if (server.pid !== serverStart.pid || server.pid !== serverStopped.pid) {
    return fail('fresh-world server PID differs from server-start and observed server-stopped PID')
  }
  const stoppedAt = timestamp(serverStopped.stoppedAt ?? serverStopped.ts)
  const processExitAt = timestamp(serverStopped.processExitObservation?.observedAt)
  const listener = serverStopped.listenerClosureObservation
  const listenerAt = timestamp(listener?.observedAt)
  if (serverStopped.schema !== 'vtr-reach-probe-lifecycle/v1' || serverStopped.event !== 'server-stopped' ||
      serverStopped.actor !== 'probe-harness' || serverStopped.sourceSha?.toLowerCase?.() !== identity.sourceSha ||
      serverStopped.runId !== identity.runId || serverStopped.generationId !== identity.generationId ||
      worldKeyString(serverStopped.worldKey) !== expectedWorldKey) {
    return fail('fresh-world post-stop observation is not bound to the exact run/source/generation/world lifecycle row')
  }
  if (!Number.isSafeInteger(serverStopped.exitCode) || serverStopped.status !== 'stopped' && serverStopped.status !== 'exited' ||
      serverStopped.processExitObservation?.schema !== 'vtr-process-exit-observation/v1' ||
      serverStopped.processExitObservation?.source !== 'child-close-event' || serverStopped.processExitObservation?.state !== 'exited' ||
      serverStopped.processExitObservation?.pid !== server.pid || serverStopped.processExitObservation?.exitCode !== serverStopped.exitCode ||
      processExitAt === null || stoppedAt === null || processExitAt > stoppedAt) {
    return incomplete('fresh-world post-stop observation lacks matching identity-bound child-close evidence')
  }
  if (listener?.schema !== 'vtr-listener-closure-observation/v1' || listener.source !== 'tcp-connect-probe' ||
      listener.state !== 'closed' || listener.host !== '127.0.0.1' || listener.port !== expectedPort ||
      listener.result !== 'connection-refused' || listenerAt === null || listenerAt < processExitAt || listenerAt !== stoppedAt) {
    return incomplete('fresh-world post-stop observation lacks loopback connection-refused evidence after server process exit')
  }
  for (const [key, expected] of Object.entries({ serverId: expectedServerId, port: expectedPort, levelName: run.levelName,
    minecraftVersion: run.minecraftVersion, dataVersion: run.dataVersion })) {
    if (server[key] === undefined || server[key] === null) return incomplete(`fresh-world server ${key} is missing`)
    if (server[key] !== expected) return fail(`fresh-world server ${key} differs from run metadata`)
  }
  if (serverStart.serverJar === undefined || serverStart.serverJarSha256 === undefined) return incomplete('server-start JAR path or hash is missing')
  if (server.minecraftVersion !== serverStart.minecraftVersion || server.dataVersion !== serverStart.dataVersion ||
      server.jarPath !== serverStart.serverJar || typeof server.jarSha256 !== 'string' ||
      server.jarSha256.toLowerCase() !== String(serverStart.serverJarSha256).toLowerCase()) {
    return fail('fresh-world Leaf version, data version, or JAR path/hash differs from server-start.json')
  }
  if (typeof server.spawnedAt !== 'string' || typeof serverStart.spawnedAt !== 'string' || server.spawnedAt !== serverStart.spawnedAt) {
    return fail('fresh-world and server-start spawnedAt do not bind the same Java process start')
  }
  for (const [key, expected] of Object.entries({ serverId: expectedServerId, port: expectedPort, levelName: run.levelName })) {
    if (serverStart[key] === undefined || serverStart[key] === null) return incomplete(`server-start ${key} is missing for fresh-world PID binding`)
    if (serverStart[key] !== expected) return fail(`server-start ${key} differs from the exact run identity`)
  }
  const process = serverStart.process
  if (!process || !Number.isSafeInteger(process.pid) || typeof process.startedAt !== 'string' ||
      typeof process.cwd !== 'string' || !isAbsolute(process.cwd) || typeof process.universeArg !== 'string' ||
      typeof process.levelNameArg !== 'string' || !Array.isArray(process.argv) || process.argv.length < 1 ||
      typeof process.commandLineSha256 !== 'string') return incomplete('server-start lacks verified process argv/CWD/world-path evidence')
  if (process.pid !== server.pid || process.levelNameArg !== run.levelName || process.startedAt !== server.spawnedAt) {
    return fail('server-start process PID/start/level does not match fresh-world identity')
  }
  const spawnObservation = serverStart.spawnObservation
  if (!spawnObservation || spawnObservation.schema !== 'vtr-server-spawn-observation/v1') {
    return incomplete('server-start lacks the run-bound actual server spawn observation')
  }
  const spawnFields = {
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    generationId: identity.generationId,
    worldKey: expectedWorldKey,
    serverId: expectedServerId,
    port: expectedPort,
    levelName: run.levelName,
    pid: server.pid,
    spawnedAt: server.spawnedAt,
    cwd: process.cwd,
    commandLineSha256: process.commandLineSha256,
    configPath: serverStart.serverPropertiesPath,
    configSha256: serverStart.serverPropertiesSha256,
    jarPath: serverStart.serverJar,
    jarSha256: serverStart.serverJarSha256,
  }
  for (const [key, expected] of Object.entries(spawnFields)) {
    if (spawnObservation[key] === undefined || spawnObservation[key] === null) return incomplete(`actual server spawn observation omits ${key}`)
    const observed = key === 'sourceSha' ? String(spawnObservation[key]).toLowerCase() : spawnObservation[key]
    if (observed !== expected) return fail(`actual server spawn observation ${key} differs from process/run identity`)
  }
  if (!Array.isArray(spawnObservation.argv) || !Array.isArray(process.argv) ||
      !isDeepStrictEqual(spawnObservation.argv, process.argv)) {
    return fail('actual server spawn observation argv differs from the observed child process argv')
  }
  const optionValues = (argv, option) => argv.flatMap((arg, index) => arg === option ? [argv[index + 1] ?? null] : [])
  const universeValues = optionValues(process.argv, '--universe')
  const levelValues = optionValues(process.argv, '--level-name')
  const configValues = optionValues(process.argv, '--config')
  const jarValues = optionValues(process.argv, '-jar')
  const argvSha = sha256(Buffer.from(process.argv.join('\0')))
  if (universeValues.length !== 1 || universeValues[0] !== process.universeArg ||
      levelValues.length !== 1 || levelValues[0] !== process.levelNameArg ||
      configValues.length !== 1 || typeof process.configArg !== 'string' || configValues[0] !== process.configArg ||
      jarValues.length !== 1 || typeof process.jarArg !== 'string' || jarValues[0] !== process.jarArg ||
      process.commandLineSha256.toLowerCase() !== argvSha) {
    return fail('server-start actual argv must bind exactly one --universe/--level-name/--config/-jar value')
  }
  const actualWorldRoot = resolve(process.cwd, process.universeArg, process.levelNameArg)
  if (resolve(worldRoot.absolute) !== actualWorldRoot) {
    return fail('fresh-world absolute root differs from the server process --universe/--level-name world path')
  }
  const actualConfigPath = resolve(process.cwd, process.configArg)
  const launchPath = serverStart.serverPropertiesPath
  if (typeof launchPath !== 'string' || !isAbsolute(launchPath) || resolve(launchPath) !== actualConfigPath ||
      resolve(process.cwd, process.jarArg) !== resolve(serverStart.serverJar)) {
    return fail('server-start actual --config/-jar argv does not match the attested config/JAR paths')
  }
  if (!['absent', 'empty-directory'].includes(preStart.state) || !Array.isArray(preStart.entries) || preStart.entries.length !== 0 ||
      preStart.levelDat?.state !== 'absent' || preStart.levelDat?.path !== join(worldRoot.absolute, 'level.dat') ||
      preStart.levelDatOld?.state !== 'absent' || preStart.levelDatOld?.path !== join(worldRoot.absolute, 'level.dat_old')) {
    return fail('pre-start world snapshot does not prove an absent/empty root and absent level.dat plus level.dat_old')
  }
  const preStartAt = timestamp(preStart.observedAt)
  const spawnedAt = timestamp(server.spawnedAt)
  if (preStartAt === null || spawnedAt === null || preStartAt >= spawnedAt) return fail('pre-start world snapshot does not precede the spawned Java PID')

  const configuration = attestation.configuration
  const launchSource = copiedSources.get('server/server.properties.launch') ?? copiedSources.get('server/server.properties.clean') ?? null
  const launch = launchSource?.bytes ?? null
  const effective = copiedSources.get('server/server.properties.effective-after-boot')?.bytes ?? copiedSources.get('server/server.properties.clean')?.bytes ?? null
  if (!configuration || launch === null || effective === null) return incomplete('fresh-world ops/ops/launch/effective config or archived bytes are absent')
  if (typeof launchSource.path !== 'string' || !isAbsolute(launchSource.path) ||
      typeof serverStart.serverPropertiesPath !== 'string' || !isAbsolute(serverStart.serverPropertiesPath) ||
      resolve(launchSource.path) !== resolve(serverStart.serverPropertiesPath)) {
    return fail('server --config path does not resolve to the actual manifest-mapped launch-properties source')
  }
  const launchSha = sha256(launch)
  const effectiveSha = sha256(effective)
  if (configuration.launchPropertiesSha256 !== launchSha || configuration.launchPropertiesSha256 !== serverStart.serverPropertiesSha256 ||
      configuration.effectivePropertiesSha256 !== effectiveSha || configuration.effectivePropertiesSha256 !== serverStart.serverPropertiesEffectiveSha256) {
    return fail('fresh-world configuration hashes differ from archived ops/ops/launch/effective properties')
  }
  if (spawnObservation.configSha256 !== launchSha || typeof spawnObservation.jarSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/iu.test(spawnObservation.jarSha256)) {
    return fail('actual server spawn observation config/JAR hashes are invalid or do not bind the archived launch config')
  }

  const logBytes = copiedSources.get('server/leaf-latest.log')?.bytes
  if (!logBytes) return incomplete('raw Leaf startup log is absent')
  const logLines = logBytes.toString('utf8').split(/\r?\n/u)
  const stdoutBytes = copiedSources.get('server/leaf-stdout-events.jsonl')?.bytes
  if (!stdoutBytes) return incomplete('spawned Leaf child stdout receipt transcript is absent')
  let stdoutRows
  try {
    stdoutRows = stdoutBytes.toString('utf8').split(/\r?\n/u).filter((line) => line.trim() !== '').map((line, index) => {
      const row = JSON.parse(line)
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`row ${index + 1} must be an object`)
      return row
    })
  } catch (error) { return fail(`spawned Leaf child stdout receipt transcript is malformed: ${error.message}`) }
  if (stdoutRows.length === 0) return incomplete('spawned Leaf child stdout receipt transcript is empty')
  let lastSequence = 0
  let lastObservedAt = -Infinity
  let lastMonotonicNs = -1n
  for (const row of stdoutRows) {
    const rowAt = timestamp(row.receivedAt)
    let monotonicNs = null
    try { if (/^\d+$/u.test(String(row.monotonicNs ?? ''))) monotonicNs = BigInt(row.monotonicNs) } catch { /* malformed below */ }
    if (row.schema !== 'vtr-server-stdout-observation/v1' || row.streamSource !== 'spawned-server-stdout' ||
        row.sourceSha?.toLowerCase?.() !== identity.sourceSha || row.runId !== identity.runId ||
        row.serverId !== expectedServerId || row.serverPid !== server.pid || row.port !== expectedPort ||
        row.levelName !== run.levelName || !Number.isSafeInteger(row.sequence) || row.sequence !== lastSequence + 1 ||
        rowAt === null || rowAt < spawnedAt || rowAt < lastObservedAt || monotonicNs === null || monotonicNs <= lastMonotonicNs ||
        typeof row.line !== 'string' || row.line.length === 0 || row.lineSha256?.toLowerCase?.() !== sha256(Buffer.from(row.line))) {
      return fail('spawned Leaf stdout receipt rows are malformed, unordered, or not bound to the exact PID/run/world')
    }
    lastSequence = row.sequence
    lastObservedAt = rowAt
    lastMonotonicNs = monotonicNs
  }
  const preparing = attestation.startupLog?.preparing
  const done = attestation.startupLog?.done
  const quotedLevel = String(run.levelName).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const preparingPattern = new RegExp(`Preparing level ["']${quotedLevel}["']`, 'u')
  const donePattern = new RegExp(`(?:Done \\([^)]*\\)!|Done preparing level ["']${quotedLevel}["'])`, 'u')
  const preparingReceipt = stdoutRows.filter((row) => row.line === preparing?.line)
  const doneReceipt = stdoutRows.filter((row) => row.line === done?.line)
  if (attestation.startupLog?.pid !== server.pid || attestation.startupLog?.streamSource !== 'spawned-server-stdout' ||
      typeof preparing?.line !== 'string' || typeof done?.line !== 'string' || !preparingPattern.test(preparing.line) ||
      !donePattern.test(done.line) || logLines.filter((line) => line === preparing.line).length !== 1 ||
      logLines.filter((line) => line === done.line).length !== 1 || preparingReceipt.length !== 1 || doneReceipt.length !== 1 ||
      preparingReceipt[0]?.line !== preparing.line || doneReceipt[0]?.line !== done.line ||
      preparingReceipt[0]?.sequence !== preparing.sequence || doneReceipt[0]?.sequence !== done.sequence ||
      preparingReceipt[0]?.receivedAt !== preparing.ts || doneReceipt[0]?.receivedAt !== done.ts ||
      preparingReceipt[0]?.lineSha256 !== preparing.lineSha256 || doneReceipt[0]?.lineSha256 !== done.lineSha256) {
    return fail('same-PID Preparing/Done startup lines are not the unique exact raw Leaf log rows for this level')
  }
  const fileRows = attestation.postRunObservation?.files
  if (!Array.isArray(fileRows) || fileRows.length < 3) return incomplete('post-run observation does not list level.dat, playerdata, and MCA artifacts')
  const preparingAt = timestamp(preparing.ts)
  const doneAt = timestamp(done.ts)
  const postRunAt = timestamp(attestation.postRunObservation?.observedAt)
  const serverStoppedAt = stoppedAt
  const latestArtifactReadAt = Array.isArray(fileRows)
    ? Math.max(...fileRows.map((entry) => timestamp(entry?.capturedAt) ?? Number.NEGATIVE_INFINITY))
    : Number.NEGATIVE_INFINITY
  if (preparingAt === null || doneAt === null || postRunAt === null || serverStoppedAt === null ||
      !(spawnedAt <= preparingAt && preparingAt < doneAt && doneAt <= serverStoppedAt &&
        serverStoppedAt <= latestArtifactReadAt && latestArtifactReadAt <= postRunAt)) {
    return fail('child stdout receipt, Leaf spawn, Preparing/Done, and post-stop artifact times are not causally ordered')
  }

  const paths = fileRows.map((entry) => entry?.archivePath)
  if (new Set(paths).size !== paths.length) return fail('post-run world artifact list contains duplicate paths')
  const playerUuid = String(run.botUuid ?? '').toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(playerUuid)) return incomplete('run metadata does not contain a canonical bot UUID for playerdata binding')
  const requiredPaths = ['server/world/level.dat', `server/world/playerdata/${playerUuid}.dat`, expectedWitnessRegionPath]
  if (requiredPaths.some((path) => typeof path !== 'string' || !paths.includes(path))) return incomplete('post-run world artifact list omits level.dat, the bot UUID playerdata file, or the witness MCA')
  for (const entry of fileRows) {
    const artifactPath = entry?.archivePath
    if (typeof artifactPath !== 'string' || !artifactPath.startsWith('server/world/') || artifactPath.split('/').includes('..') ||
        !(artifactPath.endsWith('.dat') || artifactPath.endsWith('.mca'))) return fail('post-run artifact path escapes the archived world root')
    const expectedSourcePath = join(worldRoot.absolute, artifactPath.slice('server/world/'.length).split('/').join(sep))
    if (typeof entry.sourcePath !== 'string' || !isAbsolute(entry.sourcePath) || resolve(entry.sourcePath) !== resolve(expectedSourcePath)) {
      return fail(`post-run artifact sourcePath is outside the exact observed worldRoot: ${artifactPath}`)
    }
    const capturedAt = timestamp(entry.capturedAt)
    if (entry.sourceSha?.toLowerCase?.() !== identity.sourceSha || entry.runId !== identity.runId ||
        entry.serverId !== expectedServerId || entry.serverPid !== server.pid || entry.port !== expectedPort ||
        entry.levelName !== run.levelName || capturedAt === null || capturedAt < listenerAt) {
      return fail(`post-run artifact read receipt is not identity-bound after child-close and listener refusal: ${artifactPath}`)
    }
    if (typeof entry.realPath !== 'string' || !isAbsolute(entry.realPath) || resolve(entry.realPath) !== resolve(expectedSourcePath)) {
      return fail(`post-run artifact realPath differs from its exact run world path: ${artifactPath}`)
    }
    const pathRelativeToAttempt = relative(resolve(worldRoot.attemptRoot), resolve(expectedSourcePath))
    const expectedChainPaths = [resolve(worldRoot.attemptRoot)]
    for (const part of pathRelativeToAttempt.split(sep).filter(Boolean)) expectedChainPaths.push(join(expectedChainPaths.at(-1), part))
    const pathChain = entry.pathChain
    if (!Array.isArray(pathChain) || pathChain.length !== expectedChainPaths.length ||
        pathChain.some((part, index) => part?.path !== expectedChainPaths[index] || part.realPath !== expectedChainPaths[index] ||
          part.symlink !== false || part.kind !== (index === expectedChainPaths.length - 1 ? 'file' : 'directory'))) {
      return fail(`post-run artifact path-chain receipt contains missing, redirected, or symlinked components: ${artifactPath}`)
    }
    const archived = copiedSources.get(artifactPath)
    if (!archived) return incomplete(`post-run world artifact is not archived: ${artifactPath}`)
    if (typeof archived.path !== 'string' || !isAbsolute(archived.path)) {
      return incomplete(`post-run world artifact archive omits its actual package-manifest source path: ${artifactPath}`)
    }
    if (resolve(archived.path) !== resolve(expectedSourcePath)) {
      return fail(`post-run archived source path differs from the exact worldRoot origin: ${artifactPath}`)
    }
    if (!archived.readReceipt) return incomplete(`post-run world artifact lacks its independently captured read receipt: ${artifactPath}`)
    if (!isDeepStrictEqual(archived.readReceipt, entry)) return fail(`post-run source-origin receipt differs from the fresh-world attestation: ${artifactPath}`)
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes !== archived.bytes.length || typeof entry.sha256 !== 'string' ||
        entry.sha256.toLowerCase() !== sha256(archived.bytes)) return fail(`post-run artifact size/hash differs from archived bytes: ${artifactPath}`)
    result.artifacts.push({ path: artifactPath, bytes: entry.bytes, sha256: entry.sha256.toLowerCase(),
      sourcePath: entry.sourcePath, realPath: entry.realPath, capturedAt: entry.capturedAt, pathChain: entry.pathChain })
  }
  if (!fileRows.some((entry) => entry.archivePath.endsWith('.mca'))) return incomplete('post-run observation contains no MCA region file')
  result.status = 'PASS'
  result.reason = null
  result.identity = { sourceSha: identity.sourceSha, runId: identity.runId, serverId: expectedServerId, serverPid: server.pid, port: expectedPort, levelName: run.levelName }
  return result
}
