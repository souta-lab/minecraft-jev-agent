// optionSpec.ts - #11 authority facade for first-class Options.
//
// The compiler/predicate implementation is preserved verbatim in
// optionSpec-legacy.ts. The architectural change here is the default: a normal
// resident run ALWAYS materialises System2 output as exact OptionSpec instances
// before those goals enter GoalQueue. That gives Jev pi/beta one canonical
// current Option contract (instance id, initiation/success predicates, allowed
// skills, beta threshold and runtime history) instead of an optional shadow.
//
// The compiler is unconditional: the pre-compiler plain-PlannedGoal path is
// retired, so there is no environment switch selecting it.

export * from './optionSpec-legacy.ts'
