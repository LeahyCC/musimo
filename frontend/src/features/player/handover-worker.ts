// A stopwatch for the gapless handover. A hidden tab holds the page's own timers to about one a
// second, which would land the handover a second late. A worker's timers are not held to that
// while audio plays. The page says how long to wait and gives the wait a token, and gets the token
// back when the time is up. Any new order replaces the one before it, and `delay: null` cancels.
type Order = { token: number; delay: number | null }

let timer: ReturnType<typeof setTimeout> | undefined

self.onmessage = (event: MessageEvent<Order>) => {
  clearTimeout(timer)
  const { token, delay } = event.data
  if (delay === null) return
  timer = setTimeout(() => self.postMessage(token), delay)
}

export {}
