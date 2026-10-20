import { listenerId, withListener } from '../listener/identity'

/** The name a save will write, fixed before any await. */
export type QueueSave = {
  listener: string
  generation: number
}

type Save = QueueSave & {
  body: string
  sequence: number
  resolve: (response: Response | null) => void
}

/** One active save and one latest snapshot. Server ordering makes abandoning a timeout safe. */
export class QueueWriter {
  private epoch: number | null = null
  private sequence = 0
  private running = false
  private pending: Save | null = null
  private replaced = false
  private generation = 0
  private controller: AbortController | null = null

  constructor(private failed: (replaced: boolean) => void) {}

  /** Call before the first await. A later reset makes the returned save a no-op. */
  begin(): QueueSave {
    return { listener: listenerId(), generation: this.generation }
  }

  save(body: string, begun?: QueueSave): Promise<Response | null> {
    const listener = begun?.listener ?? listenerId()
    const generation = begun?.generation ?? this.generation
    if (generation !== this.generation) return Promise.resolve(null)
    if (this.replaced) {
      return Promise.resolve(null).then(() => {
        this.failed(true)
        return null
      })
    }
    return new Promise((resolve) => {
      this.pending?.resolve(null)
      this.pending = { body, sequence: ++this.sequence, listener, generation, resolve }
      if (!this.running) void this.drain()
    })
  }

  private async drain() {
    this.running = true
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    try {
      while (this.pending && this.generation === generation) {
        const next = this.pending
        if (next.generation !== generation) {
          next.resolve(null)
          break
        }
        this.pending = null
        try {
          const signal = AbortSignal.any([AbortSignal.timeout(8000), controller.signal])
          if (this.epoch === null) {
            const response = await fetch(
              '/api/player/queue/writer',
              withListener({ method: 'POST', signal }, next.listener),
            )
            if (this.generation !== generation) {
              next.resolve(null)
              break
            }
            const value: unknown = await response.json()
            if (
              !response.ok ||
              !value ||
              typeof value !== 'object' ||
              !('epoch' in value) ||
              typeof value.epoch !== 'number' ||
              !Number.isSafeInteger(value.epoch) ||
              value.epoch < 1
            )
              throw new Error('Invalid queue writer')
            if (this.generation !== generation) {
              next.resolve(null)
              break
            }
            this.epoch = value.epoch
          }

          if (this.generation !== generation) {
            next.resolve(null)
            break
          }
          const body: unknown = JSON.parse(next.body)
          if (!body || typeof body !== 'object') throw new Error('Invalid queue snapshot')
          const response = await fetch(
            '/api/player/queue',
            withListener(
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...body, epoch: this.epoch, sequence: next.sequence }),
                signal,
              },
              next.listener,
            ),
          )
          if (this.generation !== generation) {
            next.resolve(null)
            break
          }

          if (response.status === 409) {
            // Another browser owns the queue now. Do not reclaim it with old local state.
            this.replaced = true
            this.discardPending()
          }
          if (!response.ok) this.failed(this.replaced)
          next.resolve(response)
        } catch {
          if (this.generation !== generation) {
            next.resolve(null)
            break
          }
          this.failed(false)
          next.resolve(null)
        }
      }
    } finally {
      if (this.controller === controller) this.controller = null
      this.running = false
      if (this.pending) void this.drain()
    }
  }

  /** Drops this name's epoch. A save still in flight must not finish on the next name. */
  reset() {
    this.generation += 1
    this.controller?.abort()
    this.controller = null
    this.epoch = null
    this.sequence = 0
    this.replaced = false
    this.discardPending()
  }

  private discardPending() {
    this.pending?.resolve(null)
    this.pending = null
  }
}
