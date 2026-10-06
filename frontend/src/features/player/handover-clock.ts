/**
 * A one-shot timer that a hidden tab does not slow down. It runs in a Web Worker
 * (`handover-worker.ts`), and where there is none it is the page's own `setTimeout`, which is
 * right in a visible tab and late in a hidden one. `ended` is the safety net for the late case.
 */
export type HandoverClock = {
  /** Starts the worker early, so the first `arm` does not wait for it to load. */
  warm(): void
  /** Calls `fire` after `delayMs`, replacing whatever was armed before. */
  arm(delayMs: number, fire: () => void): void
  cancel(): void
  dispose(): void
}

type Armed = { fire: () => void; due: number }

export function createHandoverClock(): HandoverClock {
  // undefined: not tried yet. null: none here (or it failed), so the page's timer stands in.
  let worker: Worker | null | undefined
  // Names the current wait. A message from the worker for any other one is stale and ignored.
  let token = 0
  let armed: Armed | null = null
  let fallback: number | undefined

  // The page's own timer, for a wait the worker cannot keep.
  function startFallback(current: Armed) {
    window.clearTimeout(fallback)
    fallback = window.setTimeout(
      () => {
        if (armed !== current) return
        armed = null
        current.fire()
      },
      Math.max(0, current.due - performance.now()),
    )
  }

  function open(): Worker | null {
    if (worker !== undefined) return worker
    try {
      const created = new Worker(new URL('./handover-worker.ts', import.meta.url), {
        type: 'module',
      })
      created.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data !== token || !armed) return
        const { fire } = armed
        armed = null
        fire()
      }

      created.onerror = () => {
        created.terminate()
        worker = null
        if (armed) startFallback(armed)
      }
      worker = created
    } catch {
      worker = null
    }
    return worker
  }

  function forget() {
    token += 1
    armed = null
    window.clearTimeout(fallback)
  }

  return {
    warm: () => void open(),
    arm(delayMs, fire) {
      forget()
      const current: Armed = { fire, due: performance.now() + delayMs }
      armed = current
      const port = open()
      if (port) port.postMessage({ token, delay: delayMs })
      else startFallback(current)
    },
    cancel() {
      forget()
      worker?.postMessage({ token, delay: null })
    },
    dispose() {
      forget()
      worker?.terminate()
      worker = undefined
    },
  }
}
