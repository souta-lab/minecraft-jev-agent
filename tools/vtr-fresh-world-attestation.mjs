import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

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
  const argvUniverseIndex = process.argv.findIndex((arg, index) => arg === '--universe' && process.argv[index + 1] === process.universeArg)
  const argvLevelIndex = process.argv.findIndex((arg, index) => arg === '--level-name' && process.argv[index + 1] === process.levelNameArg)
  const argvSha = sha256(Buffer.from(process.argv.join('\0')))
  if (argvUniverseIndex < 0 || argvLevelIndex < 0 || process.commandLineSha256.toLowerCase() !== argvSha) {
    return fail('server-start actual argv does not bind its declared --universe/--level-name values')
  }
  const actualWorldRoot = resolve(process.cwd, process.universeArg, process.levelNameArg)
  if (resolve(worldRoot.absolute) !== actualWorldRoot) {
    return fail('fresh-world absolute root differs from the server process --universe/--level-name world path')
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
  const launch = copiedSources.get('server/server.properties.launch')?.bytes ?? copiedSources.get('server/server.properties.clean')?.bytes ?? null
  const effective = copiedSources.get('server/server.properties.effective-after-boot')?.bytes ?? copiedSources.get('server/server.properties.clean')?.bytes ?? null
  if (!configuration || launch === null || effective === null) return incomplete('fresh-world launch/effective config or archived bytes are absent')
  const launchSha = sha256(launch)
  const effectiveSha = sha256(effective)
  if (configuration.launchPropertiesSha256 !== launchSha || configuration.launchPropertiesSha256 !== serverStart.serverPropertiesSha256 ||
      configuration.effectivePropertiesSha256 !== effectiveSha || configuration.effectivePropertiesSha256 !== serverStart.serverPropertiesEffectiveSha256) {
    return fail('fresh-world configuration hashes differ from archived launch/effective properties')
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
        rowAt === null || rowAt < lastObservedAt || monotonicNs === null || monotonicNs <= lastMonotonicNs ||
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
  const preparingReceipt = stdoutRows.filter((row) => preparingPattern.test(row.line))
  const doneReceipt = stdoutRows.filter((row) => donePattern.test(row.line))
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
  const preparingAt = timestamp(preparing.ts)
  const doneAt = timestamp(done.ts)
  const postRunAt = timestamp(attestation.postRunObservation?.observedAt)
  const serverStoppedAt = timestamp(serverStopped.stoppedAt ?? serverStopped.ts)
  if (preparingAt === null || doneAt === null || postRunAt === null || serverStoppedAt === null ||
      !(spawnedAt <= preparingAt && preparingAt < doneAt && doneAt <= serverStoppedAt && serverStoppedAt <= postRunAt)) {
    return fail('child stdout receipt, Leaf spawn, Preparing/Done, and post-stop artifact times are not causally ordered')
  }

  const fileRows = attestation.postRunObservation?.files
  if (!Array.isArray(fileRows) || fileRows.length < 3) return incomplete('post-run observation does not list level.dat, playerdata, and MCA artifacts')
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
    const archived = copiedSources.get(artifactPath)
    if (!archived) return incomplete(`post-run world artifact is not archived: ${artifactPath}`)
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes !== archived.bytes.length || typeof entry.sha256 !== 'string' ||
        entry.sha256.toLowerCase() !== sha256(archived.bytes)) return fail(`post-run artifact size/hash differs from archived bytes: ${artifactPath}`)
    result.artifacts.push({ path: artifactPath, bytes: entry.bytes, sha256: entry.sha256.toLowerCase() })
  }
  if (!fileRows.some((entry) => entry.archivePath.endsWith('.mca'))) return incomplete('post-run observation contains no MCA region file')
  result.status = 'PASS'
  result.reason = null
  result.identity = { sourceSha: identity.sourceSha, runId: identity.runId, serverId: expectedServerId, serverPid: server.pid, port: expectedPort, levelName: run.levelName }
  return result
}
