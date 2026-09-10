// Parallel test runs pick their own port and Compose project so they do not collide.
export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:18765'
export const ORIGIN = new URL(BASE_URL).origin
export const CI_PROJECT = process.env.MUSIMO_CI_PROJECT ?? 'musimo-ci'
