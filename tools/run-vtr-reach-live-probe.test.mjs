import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  main,
  parseCliArgs,
  parseJavaMajor,
  parseJavaRuntime,
  propertiesObject,
  renderProbeServerProperties,
  residentTerminationProblems,
  persistRunPreflightFailure,
  runRuntimeResolutionSmoke,
  startRowFromLog,
  terminateOwnedProcessGroup,
  inspectExactSourceDependencyReadiness,
  inspectLeafEula,
  runNoDoubleAuthorityFixture,
  validateExactSourceWorkspaceInstall,
  validatePortPolicy,
  writeSetupFailureArtifact,
} from './run-vtr-reach-live-probe.mjs'

function writeWorkspaceFixture(root, { linkTarget = null } = {}) {
  mkdirSync(join(root, 'unused-workspace'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', workspaces: ['unused-workspace'], dependencies: {} }))
  writeFileSync(join(root, 'bun.lock'), JSON.stringify({ workspaces: {
    '': { name: 'fixture-root' },
    'unused-workspace': { name: 'unused-workspace', version: '1.0.0' },
  } }))
  writeFileSync(join(root, 'unused-workspace', 'package.json'), JSON.stringify({ name: 'unused-workspace', version: '1.0.0', dependencies: {} }))
  if (linkTarget) {
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    symlinkSync(linkTarget, join(root, 'node_modules', 'unused-workspace'), 'dir')
  }
}

describe('Reach live probe caller pure contracts', () => {
  test('help parsing does not require a live server configuration', () => {
    expect(parseCliArgs(['--help']).help).toBe(true)
    expect(() => parseCliArgs(['--run', '--port', '25576'])).toThrow(/protected/iu)
    expect(() => validatePortPolicy(25577, 4173)).toThrow(/protected/iu)
    expect(validatePortPolicy(25577, 4175)).toBe(true)
  })

  test('Java properties parser honors escaped separators in flat-world config', () => {
    const properties = propertiesObject('level-type=minecraft\\:flat\nserver-port=25577\n')
    expect(properties['level-type']).toBe('minecraft:flat')
    expect(properties['server-port']).toBe('25577')
    expect(propertiesObject(renderProbeServerProperties({ port: 25577, levelName: 'vtrreach-a1b2c3d4-11223344' }))['level-type']).toBe('minecraft:flat')
  })

  test('Java version parser accepts version text emitted on stderr', () => {
    expect(parseJavaMajor('openjdk version "21.0.4" 2026-07-15')).toBe(21)
    expect(parseJavaMajor('java version "1.8.0_402"')).toBe(8)
    expect(parseJavaMajor('not a Java version')).toBeNull()
    expect(parseJavaRuntime('openjdk version "21.0.4" 2026-07-15')).toEqual({
      major: 21, version: '21.0.4', earlyAccess: false,
    })
  })

  test('Java preflight distinguishes unsupported early-access builds from general-availability builds', () => {
    expect(parseJavaRuntime('openjdk version "25.0.5-ea" 2026-10-20')).toEqual({
      major: 25, version: '25.0.5-ea', earlyAccess: true,
    })
    expect(parseJavaRuntime('openjdk version "25-ea" 2026-10-20')).toMatchObject({ major: 25, earlyAccess: true })
  })

  test('fresh Leaf attempts require and preserve the existing EULA acceptance', () => {
    const parent = mkdtempSync(join(tmpdir(), 'vtr-leaf-eula-'))
    const leafJar = join(parent, 'leaf.jar')
    writeFileSync(leafJar, 'fixture jar')
    writeFileSync(join(parent, 'eula.txt'), '# existing acceptance\neula=true\n')
    try {
      expect(inspectLeafEula(leafJar)).toMatchObject({
        sourcePath: join(parent, 'eula.txt'),
        contents: '# existing acceptance\neula=true\n',
      })
      writeFileSync(join(parent, 'eula.txt'), 'eula=false\n')
      expect(() => inspectLeafEula(leafJar)).toThrow(/eula=true.*required/iu)
      writeFileSync(join(parent, 'eula.txt'), 'eula=true\neula=false\n')
      expect(() => inspectLeafEula(leafJar)).toThrow(/eula=true.*required/iu)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('exact-source install accepts an unused declared workspace without a Bun link', () => {
    const parent = mkdtempSync(join(tmpdir(), 'vtr-workspace-install-'))
    const root = join(parent, 'source')
    mkdirSync(root)
    try {
      writeWorkspaceFixture(root)
      const report = validateExactSourceWorkspaceInstall(root, ['unused-workspace'])
      expect(report.workspaceLinks['unused-workspace'].installedLink.status).toBe('NOT_LINKED')
      expect(report.workspaceLinks['unused-workspace'].bunLockWorkspace).toEqual({
        path: 'unused-workspace', name: 'unused-workspace', version: '1.0.0',
      })
      expect(report.workspaceValidation).toMatchObject({ status: 'PASS', absentUnusedLinksAllowed: true, installedLinksChecked: true })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('exact-source install rejects a present workspace link that escapes the checkout', () => {
    const parent = mkdtempSync(join(tmpdir(), 'vtr-workspace-link-'))
    const root = join(parent, 'source')
    const external = join(parent, 'outside-workspace')
    mkdirSync(root)
    mkdirSync(external)
    try {
      writeWorkspaceFixture(root, { linkTarget: external })
      expect(() => validateExactSourceWorkspaceInstall(root, ['unused-workspace']))
        .toThrow(/resolves outside the exact-source tree/iu)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('preflight and frozen install share bun.lock, manifest, config, and workspace-link readiness', () => {
    const readiness = inspectExactSourceDependencyReadiness(process.cwd())
    expect(readiness.lockSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(readiness.workspaceInstall.workspaceValidation.status).toBe('PASS')
    expect(readiness.workspaceInstall.workspaceValidation.absentUnusedLinksAllowed).toBe(true)
  })

  test('Bun resolves actual resident and Jev generation entrypoint graphs without executing them', () => {
    const installedDependencies = existsSync(join(process.cwd(), 'node_modules', 'mineflayer', 'package.json'))
    const mode = installedDependencies ? 'full' : 'source-graph'
    const smoke = runRuntimeResolutionSmoke(process.cwd(), { mode })
    expect(smoke).toMatchObject({
      schema: 'vtr-runtime-entrypoint-resolution-smoke/v1',
      status: 'PASS',
      resolver: 'Bun.build(target=bun,write=false)',
      entrypoints: ['buddy-driver/agent-runner.mts', 'buddy-driver/generation-entry.ts'],
      mode,
      outputCount: 2,
    })
    expect(smoke.errors).toEqual([])
  })

  test('exact-source no-double-authority fixture runs through its Bun-discoverable test entry', () => {
    const parent = mkdtempSync(join(tmpdir(), 'vtr-no-double-authority-runner-'))
    const attemptRoot = join(parent, 'attempt')
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim()
    try {
      const result = runNoDoubleAuthorityFixture(process.cwd(), attemptRoot, sourceSha)
      expect(result.testEntryRelative).toBe('jev-agent/vtr-reach-executor-dispatch-authority.test.mts')
      expect(result.sourceSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(result.gitObjectSha256).toBe(result.sourceSha256)
      expect(result.testEntrySha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(result.gitTestEntryObjectSha256).toBe(result.testEntrySha256)
      expect(result.report).toMatchObject({
        schema: 'vtr-reach-no-double-authority-fixture/v1',
        result: 'PASS',
        sourceSha,
        test: { path: 'jev-agent/test-vtr-reach-executor-dispatch-authority.mts' },
        fixture: { legacyClaimRejected: true, vtrOwnerRetained: true, authorityConflictCount: 1 },
      })
      expect(existsSync(result.sourcePath)).toBe(true)
      expect(existsSync(result.testEntryPath)).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('staged setup failure records exact cause before the CLI returns', () => {
    const parent = mkdtempSync(join(tmpdir(), 'vtr-setup-failure-'))
    const attempt = join(parent, 'attempt')
    mkdirSync(join(attempt, 'runner'), { recursive: true })
    try {
      const preflightPath = join(attempt, 'runner', 'preflight.json')
      writeFileSync(preflightPath, '{"status":"PASS"}\n')
      const path = writeSetupFailureArtifact(attempt, {
        sourceSha: 'a'.repeat(40), stage: 'frozen-dependency-install',
        error: new Error('workspace identity mismatch api_key=should-not-escape'), preflightPath,
        cleanup: { status: 'CLEANED', attempted: true, worktree: { status: 'REMOVED' }, caches: [] },
      })
      const report = JSON.parse(readFileSync(path, 'utf8'))
      expect(report).toMatchObject({
        schema: 'vtr-reach-live-caller-failure/v1',
        sourceSha: 'a'.repeat(40),
        phase: 'frozen-dependency-install',
        failureStage: 'frozen-dependency-install',
        reason: 'workspace identity mismatch api_key=[REDACTED]',
        cleanup: { status: 'CLEANED', attempted: true, worktree: { status: 'REMOVED' } },
        components: { leafServer: 'NOT_STARTED', observer: 'NOT_STARTED', resident: 'NOT_STARTED' },
      })
      expect(report.attemptRoot).toBe(attempt)
      expect(Date.parse(report.capturedAt)).not.toBeNaN()
      expect(report.evidence).toHaveLength(1)
      expect(report.evidence[0]).toMatchObject({ path: 'runner/preflight.json', bytes: Buffer.byteLength('{"status":"PASS"}\n') })
      expect(report.evidence[0].sha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(JSON.stringify(report)).not.toContain('should-not-escape')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('blocked --run preflight persists a redacted runner-failure artifact without starting services', () => {
    const parent = mkdtempSync(join(tmpdir(), 'vtr-preflight-failure-'))
    const attemptRoot = join(parent, 'attempt')
    const options = { attemptRoot }
    const report = {
      schema: 'vtr-reach-live-probe-preflight/v1',
      status: 'BLOCKED',
      sourceSha: 'b'.repeat(40),
      attemptRoot,
      blockers: [{ id: 'runtime-dependencies', reason: 'Bun resolver missing token=[REDACTED]' }],
      checks: [
        { id: 'attempt-isolation', status: 'PASS' },
        { id: 'runtime-dependencies', status: 'BLOCKED', preflightDetail: {
          temporaryInstallRemoved: true,
          cleanup: { worktree: { status: 'REMOVED' }, scratch: { status: 'REMOVED' } },
        } },
      ],
      servicesStarted: { leafServer: false, observer: false, resident: false },
    }
    try {
      const result = persistRunPreflightFailure(options, report)
      expect(result.status).toBe('WRITTEN')
      const failurePath = join(attemptRoot, result.path)
      const failure = JSON.parse(readFileSync(failurePath, 'utf8'))
      expect(failure).toMatchObject({
        schema: 'vtr-reach-live-caller-failure/v1',
        sourceSha: 'b'.repeat(40),
        phase: 'preflight',
        reason: 'preflight blocked at runtime-dependencies: Bun resolver missing token=[REDACTED]',
        cleanup: { status: 'CLEANED', temporaryPreflightInstall: 'REMOVED' },
        components: { leafServer: 'NOT_STARTED', observer: 'NOT_STARTED', resident: 'NOT_STARTED' },
        preflightPath: join(attemptRoot, 'runner', 'preflight.json'),
      })
      expect(failure.evidence).toHaveLength(1)
      expect(failure.evidence[0].path).toBe('runner/preflight.json')
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(existsSync(join(attemptRoot, 'runner', 'preflight.json'))).toBe(true)
      expect(JSON.stringify(failure)).not.toContain('token=secret')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('Leaf startup log rows require stdout provenance and ordered exact level evidence', () => {
    const rows = [
      { stream: 'spawned-child-stderr', ts: '2026-09-25T00:00:00.000Z', line: 'Starting minecraft server version 1.21.11' },
      { stream: 'spawned-child-stdout', ts: '2026-09-25T00:00:01.000Z', line: 'Starting minecraft server version 1.21.11' },
      { stream: 'spawned-child-stdout', ts: '2026-09-25T00:00:02.000Z', line: 'Preparing level "vtrreach-a1b2c3d4-11223344"' },
      { stream: 'spawned-child-stdout', ts: '2026-09-25T00:00:03.000Z', line: 'Done preparing level "vtrreach-a1b2c3d4-11223344"' },
    ]
    expect(startRowFromLog(rows, 'vtrreach-a1b2c3d4-11223344')?.minecraftVersion).toBe('1.21.11')
    expect(startRowFromLog(rows.filter((row) => row.stream !== 'spawned-child-stdout'), 'vtrreach-a1b2c3d4-11223344')).toBeNull()
  })

  test('target child process-group closure is required and distinct from guard-wrapper closure', async () => {
    const valid = residentTerminationProblems({
      guardLoaded: { pid: 22002 },
      guardClosed: { childPid: 22002, childExitCode: 0, processGroupGone: true },
      wrapperPid: 22001,
      residentPid: 22002,
      wrapperClose: { pid: 22001, exitCode: 0, signal: null },
      processGroupClosure: { schema: 'vtr-process-group-closure/v1', pgid: 22002, state: 'gone' },
    })
    expect(valid).toEqual([])
    const orphaned = residentTerminationProblems({
      guardLoaded: { pid: 22002 },
      guardClosed: { childPid: 22003, childExitCode: 0, processGroupGone: false },
      wrapperPid: 22001,
      residentPid: 22002,
      wrapperClose: { pid: 22001, exitCode: 0, signal: null },
      processGroupClosure: { schema: 'vtr-process-group-closure/v1', pgid: 22003, state: 'INCOMPLETE' },
    })
    expect(orphaned).toContain('guard-child-close-pid-mismatch')
    expect(orphaned).toContain('target-process-group-not-observed-gone')
  })

  test('escalation signals the nested target process group and confirms it gone', async () => {
    let present = true
    const signals = []
    const killFn = (target, signal) => {
      if (signal === 0) {
        if (!present) {
          const error = new Error('no such process group')
          error.code = 'ESRCH'
          throw error
        }
        return
      }
      signals.push({ target, signal })
      if (signal === 'SIGKILL') present = false
    }
    const result = await terminateOwnedProcessGroup(22002, {
      killFn,
      termTimeoutMs: 0,
      killTimeoutMs: 100,
      wait: async () => {},
    })
    expect(result.state).toBe('gone')
    expect(result.pgid).toBe(22002)
    expect(signals).toEqual([{ target: -22002, signal: 'SIGTERM' }, { target: -22002, signal: 'SIGKILL' }])
  })

  test('target process group still present after SIGKILL is incomplete', async () => {
    const result = await terminateOwnedProcessGroup(22002, {
      killFn: () => {},
      observe: () => ({ state: 'present', pgid: 22002 }),
      termTimeoutMs: 0,
      killTimeoutMs: 0,
      wait: async () => {},
    })
    expect(result.state).toBe('INCOMPLETE')
    expect(result.finalObservation.state).toBe('present')
  })

  test('actual CLI help entrypoint succeeds without starting services', async () => {
    const original = process.stdout.write
    let captured = ''
    process.stdout.write = (chunk) => { captured += String(chunk); return true }
    try {
      expect(await main(['--help'])).toBe(0)
    } finally {
      process.stdout.write = original
    }
    expect(captured).toContain('--preflight')
    expect(captured).toContain('--run')
  })
})
