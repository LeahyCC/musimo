/** Reloads of the playing track after a dropped connection, before it stays on the song. */
export const NETWORK_RETRIES = 3
/** The wait before the first reload. Each later one waits this much longer. */
export const NETWORK_RETRY_DELAY_MS = 1000
/**
 * How far past the point it last dropped a reloaded track has to play before its reloads are
 * counted from zero again. Starting to play is not enough: a server that fails the same range every
 * time lets each reload start and then drops it at the same spot, and would reload it forever.
 */
export const NETWORK_RECOVERED_SECONDS = 5
