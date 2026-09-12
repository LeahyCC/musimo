// The feature extractor runs off the main thread so a slow frame in the
// renderer cannot stall the analysis, and vice versa. See features.protocol.ts.
import { createFeatureWorkerSession } from './features.protocol'
import type { ToWorker } from './features.protocol'

const session = createFeatureWorkerSession((message, transfer) =>
  self.postMessage(message, { transfer }),
)

self.onmessage = (event: MessageEvent<ToWorker>) => session.handle(event.data)
