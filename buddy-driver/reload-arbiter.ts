// reload-arbiter.ts - serialize host reload requests.
//
// The resident has two reload producers: the debounced source watcher and the
// control socket. Both can observe the same source change while an async
// build/import/swap is still running. Keep at most one reload in flight and
// coalesce the next request so two candidates cannot attach against the same
// live bot at once.

export type ReloadRunner = (trigger: string) => Promise<void>
export type ReloadArbiterLog = (event: string, detail?: Record<string, unknown>) => void
export type ReloadRequestResult = 'started' | 'queued' | 'ignored'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ReloadArbiter {
  private inFlight: Promise<void> | null = null
  private queuedTrigger: string | null = null
  private stopped = false

  constructor(
    private readonly run: ReloadRunner,
    private readonly canContinue: () => boolean = () => true,
    private readonly log?: ReloadArbiterLog,
  ) {}

  /** Start a reload, or queue one bounded follow-up while another is running. */
  request(trigger: string): ReloadRequestResult {
    if (this.stopped || !this.canContinue()) return 'ignored'
    if (this.inFlight !== null) {
      if (this.queuedTrigger === null) this.queuedTrigger = trigger
      this.log?.('RELOAD_COALESCED', {
        trigger,
        queuedTrigger: this.queuedTrigger,
      })
      return 'queued'
    }

    let run: Promise<void>
    try {
      run = this.run(trigger)
    } catch (error) {
      run = Promise.reject(error)
    }
    this.inFlight = run
    void run.then(
      () => this.finish(run),
      (error: unknown) => {
        this.log?.('ERROR', { where: 'reload-arbiter', trigger, message: errorMessage(error) })
        this.finish(run)
      },
    )
    return 'started'
  }

  /** Prevent a queued follow-up from starting during host shutdown. */
  stop(): void {
    this.stopped = true
    this.queuedTrigger = null
  }

  get running(): boolean {
    return this.inFlight !== null
  }

  get pendingTrigger(): string | null {
    return this.queuedTrigger
  }

  private finish(completed: Promise<void>): void {
    if (this.inFlight !== completed) return
    this.inFlight = null
    const next = this.queuedTrigger
    this.queuedTrigger = null
    if (next === null || this.stopped || !this.canContinue()) return
    this.request(next)
  }
}
