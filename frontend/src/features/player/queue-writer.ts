type Save = {
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

  constructor(private failed: (replaced: boolean) => void) {}

  save(body: string): Promise<Response | null> {
    if (this.replaced) {
      return Promise.resolve(null).then(() => {
        this.failed(true)
        return null
      })
    }
    return new Promise((resolve) => {
      this.pending?.resolve(null)
      this.pending = { body, sequence: ++this.sequence, resolve }
      if (!this.running) void this.drain()
    })
  }

  private async drain() {
    this.running = true
    while (this.pending) {
      const next = this.pending
      this.pending = null
      try {
        if (this.epoch === null) {
          const response = await fetch('/api/player/queue/writer', {
            method: 'POST',
            signal: AbortSignal.timeout(8000),
          })
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
          this.epoch = value.epoch
        }
        const body: unknown = JSON.parse(next.body)
        if (!body || typeof body !== 'object') throw new Error('Invalid queue snapshot')
        const response = await fetch('/api/player/queue', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, epoch: this.epoch, sequence: next.sequence }),
          signal: AbortSignal.timeout(8000),
        })
        if (response.status === 409) {
          // Another browser owns the queue now. Do not reclaim it with old local state.
          this.replaced = true
          this.discardPending()
        }
        if (!response.ok) this.failed(this.replaced)
        next.resolve(response)
      } catch {
        this.failed(false)
        next.resolve(null)
      }
    }
    this.running = false
  }

  private discardPending() {
    this.pending?.resolve(null)
    this.pending = null
  }
}
