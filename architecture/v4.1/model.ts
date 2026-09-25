/**
 * V4.1.2 compatibility entrypoint.
 *
 * The production-facing executable architecture authority lives in kernel.ts.
 * V4.1.1's independently mutable model helpers were intentionally removed so
 * callers cannot bypass the transactional KernelCommand -> KernelState reducer.
 */
export * from './kernel.ts'
