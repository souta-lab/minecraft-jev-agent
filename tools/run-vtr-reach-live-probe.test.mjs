import { describe, expect, test } from 'bun:test'
import {
  main,
  parseCliArgs,
  parseJavaMajor,
  propertiesObject,
  renderProbeServerProperties,
  residentTerminationProblems,
  startRowFromLog,
  terminateOwnedProcessGroup,
  validatePortPolicy,
} from './run-vtr-reach-live-probe.mjs'

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
