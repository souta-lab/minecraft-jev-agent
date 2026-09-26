// test-oscillation-churn.mts - the loop detector must survive junk pickups.
//
// Live defect: the pacing body walked `MOVE:p197` <-> `MOVE:p199` for minutes while
// picking up `dirt` / `leaf_litter`. `evaluateOscillation`'s signature embeds an
// inventory snapshot, so every pickup re-armed the detector (cycles reset to 0)
// and `OSCILLATION_DETECTED` never fired - the escape action (blacklist both ends)
// never ran. The goal key is the real boundary; inventory churn must not mask a
// positional loop.
//
//   bun ./test-oscillation-churn.mts
import { evaluateOscillation } from './src/oscillation.ts'

let failures = 0
const check = (name: string, run: () => boolean, detail: () => string): void => {
  let pass = false
  let info = ''
  try {
    pass = run()
    info = detail()
  } catch (error) {
    info = `threw ${String(error)}`
  }
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${info}\n`)
}

const walk = (options: { goal: string; inventory: (cycle: number) => string; steps: number }) => {
  let state = null as ReturnType<typeof evaluateOscillation>['state'] | null
  let detectedAt = -1
  let cycles = 0
  for (let step = 0; step < options.steps; step += 1) {
    const cycle = Math.floor(step / 2)
    const position = step % 2 === 0 ? 'p197' : 'p199'
    const decision = evaluateOscillation({
      position,
      signature: `${options.goal}|${options.inventory(cycle)}`,
      previous: state,
      goal: options.goal,
    })
    state = decision.state
    cycles = decision.state.cycles
    if (decision.detected && detectedAt < 0) detectedAt = step
  }
  return { detectedAt, cycles }
}

check(
  'a positional loop is detected even while the inventory churns every cycle',
  () => {
    const result = walk({ goal: 'collect:obsidian:10', inventory: (cycle) => `dirt:${cycle}`, steps: 24 })
    return result.detectedAt >= 0
  },
  () => JSON.stringify(walk({ goal: 'collect:obsidian:10', inventory: (cycle) => `dirt:${cycle}`, steps: 24 })),
)

check(
  'a stable inventory still fires at the original (single) limit',
  () => {
    const result = walk({ goal: 'collect:obsidian:10', inventory: () => 'dirt:1', steps: 24 })
    return result.detectedAt >= 0 && result.detectedAt <= 8
  },
  () => JSON.stringify(walk({ goal: 'collect:obsidian:10', inventory: () => 'dirt:1', steps: 24 })),
)

check(
  'a goal change still re-arms the detector',
  () => {
    let state = null as ReturnType<typeof evaluateOscillation>['state'] | null
    const step = (position: string, goal: string, signature: string) => {
      const decision = evaluateOscillation({ position, signature, previous: state, goal })
      state = decision.state
      return decision
    }
    for (let index = 0; index < 8; index += 1) step(index % 2 === 0 ? 'p197' : 'p199', 'collect:obsidian:10', 'g1')
    const afterGoalChange = step('p199', 'collect:flint:1', 'g2')
    return afterGoalChange.detected === false && afterGoalChange.state.cycles <= 1
  },
  () => 'goal change resets cycles',
)

process.stdout.write(`${'-'.repeat(72)}\n${3 - failures}/3 oscillation-churn cases passed\n`)
if (failures > 0) process.exit(1)
