// optionSpec.ts - #11 authority facade for first-class Options.
//
// The compiler/predicate implementation is preserved verbatim in
// optionSpec-legacy.ts. The architectural change here is the default: a normal
// resident run ALWAYS materialises System2 output as exact OptionSpec instances
// before those goals enter GoalQueue. That gives Jev pi/beta one canonical
// current Option contract (instance id, initiation/success predicates, allowed
// skills, beta threshold and runtime history) instead of an optional shadow.
//
// Explicit OFF remains as an A/B / rollback baseline only.

export * from './optionSpec-legacy.ts'

export const OPTION_COMPILER_ENV = 'BUDDY_OPTION_COMPILER'

/**
 * #11/#56 authority contract: Option runtime is ON by default.
 *
 * Credentials/capability do not decide this layer and there is no `auto` mode:
 * normal execution uses first-class Options; only an explicit negative value
 * restores the historical plain-PlannedGoal path for comparison/rollback.
 */
export function resolveOptionCompilerEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = (env[OPTION_COMPILER_ENV] ?? '').trim().toLowerCase()
  if (raw === '' || raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false
  throw new Error(
    `invalid ${OPTION_COMPILER_ENV}=${JSON.stringify(env[OPTION_COMPILER_ENV])}; ` +
      'expected on/true/1/yes or explicit off/false/0/no',
  )
}
