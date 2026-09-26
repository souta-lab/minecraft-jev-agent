import assert from 'node:assert/strict'
import { GoalQueue } from '../jev-agent/src/goalQueue.ts'
import { parseHumanIntentCommand, parseQuantityReply } from './human-intent.ts'

assert.deepEqual(parseHumanIntentCommand('/agent AI_Buddy diamondを掘ってきて', 'AI_Buddy'), {
  kind: 'collect',
  item: 'diamond',
  count: null,
  raw: '/agent AI_Buddy diamondを掘ってきて',
})
assert.deepEqual(parseHumanIntentCommand('agent AI_Buddy ダイヤを3個掘ってきて', 'AI_Buddy'), {
  kind: 'collect',
  item: 'diamond',
  count: 3,
  raw: 'agent AI_Buddy ダイヤを3個掘ってきて',
})
assert.deepEqual(parseHumanIntentCommand('/agent AI_Buddy collect obsidian 10', 'AI_Buddy')?.kind, 'collect')
assert.equal(parseHumanIntentCommand('/agent SomeoneElse diamond 3', 'AI_Buddy'), null)
assert.equal(parseHumanIntentCommand('/agent AI_Buddy status', 'AI_Buddy')?.kind, 'status')
assert.equal(parseHumanIntentCommand('/agent AI_Buddy 自由にして', 'AI_Buddy')?.kind, 'free')
assert.equal(parseQuantityReply('3'), 3)
assert.equal(parseQuantityReply('12個'), 12)
assert.equal(parseQuantityReply('0'), null)

const queue = new GoalQueue()
queue.applyPlan(
  [
    { kind: 'collect', description: 'collect 7 x blaze_rod', targetItem: 'blaze_rod', requiredCount: 7 },
    { kind: 'craft', description: 'craft 12 x ender_eye', targetItem: 'ender_eye', requiredCount: 12 },
  ],
  'llm',
)
const missionHead = queue.current?.id
const added = queue.interruptWithHumanPlan([
  { kind: 'collect', description: 'collect 3 x diamond', targetItem: 'diamond', requiredCount: 3 },
])
assert.equal(added.length, 1)
assert.equal(queue.current?.origin, 'human')
assert.equal(queue.current?.targetItem, 'diamond')
assert.equal(queue.current?.protected, true)
assert.equal(queue.state.goals.find((goal) => goal.id === missionHead)?.status, 'pending')

queue.interruptWithHumanPlan([
  { kind: 'collect', description: 'collect 10 x obsidian', targetItem: 'obsidian', requiredCount: 10 },
])
const unfinished = queue.state.goals.filter((goal) => goal.status === 'active' || goal.status === 'pending')
assert.deepEqual(unfinished.slice(0, 4).map((goal) => [goal.origin, goal.targetItem]), [
  ['human', 'diamond'],
  ['human', 'obsidian'],
  ['llm', 'blaze_rod'],
  ['llm', 'ender_eye'],
])

// System2 cannot mutate the plan while human WHAT authority is active.
const rejected: string[] = []
queue.applyPlan(
  [{ kind: 'collect', description: 'model diamond', targetItem: 'diamond', requiredCount: 1 }],
  'llm',
  'replace',
  { onOperationRejected: (line) => rejected.push(line) },
)
assert.equal(queue.current?.origin, 'human')
assert.equal(queue.current?.requiredCount, 3)
assert.equal(rejected[0], 'PLAN_OP_REJECTED op=replace reason=human_interrupt_active')
assert.equal(queue.state.goals.some((goal) => goal.targetItem === 'blaze_rod' && goal.origin === 'llm'), true)

const cleared = queue.clearHumanInterrupts('free')
assert.equal(cleared.length, 2)
assert.equal(queue.current?.origin, 'llm')
assert.equal(queue.current?.targetItem, 'blaze_rod')

console.log('human-intent: PASS')
