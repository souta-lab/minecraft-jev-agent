// test-surface-recovery.mts - #136 proof that vertical recovery is not complete
// at Y alone. The controller and Option compiler share the same two-part
// contract: reach the upper-access hint and obtain the explicit log resource.
import { evaluateSurfaceRecovery } from './src/controller.ts'

const goal = {
  kind: 'surface' as const,
  targetY: 68,
  dimension: 'minecraft:overworld',
  targetItem: 'log',
  requiredCount: 1,
}

const yOnly = evaluateSurfaceRecovery(goal, {
  position: { x: 0, y: 80, z: 0 },
  dimension: 'minecraft:overworld',
  inventory: {},
})
const logOnly = evaluateSurfaceRecovery(goal, {
  position: { x: 0, y: 60, z: 0 },
  dimension: 'minecraft:overworld',
  inventory: { oak_log: 1 },
})
const complete = evaluateSurfaceRecovery(goal, {
  position: { x: 0, y: 68, z: 0 },
  dimension: 'minecraft:overworld',
  inventory: { oak_log: 1 },
})

const pass =
  yOnly !== null && !yOnly.satisfied && yOnly.vertical.satisfied && !yOnly.resourceSatisfied &&
  logOnly !== null && !logOnly.satisfied && !logOnly.vertical.satisfied && logOnly.resourceSatisfied &&
  complete?.satisfied === true

process.stdout.write(`surface recovery predicate #136: ${pass ? 'PASS' : 'FAIL'}\n`)
process.stdout.write(`  yOnly=${JSON.stringify(yOnly)}\n`)
process.stdout.write(`  logOnly=${JSON.stringify(logOnly)}\n`)
process.stdout.write(`  complete=${JSON.stringify(complete)}\n`)
if (!pass) process.exit(1)
