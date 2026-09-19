import type { Rgb } from './theme/color'

/* The cover's dominant color, for the wash behind Now Playing. The reading happens on a small
   canvas that is never attached, so a big cover costs a 24 by 24 read and no more. */

/** Pixels a side. Enough to tell what dominates, and few enough to be free. */
const SAMPLE = 24
const MAX_CACHED = 40

type Bucket = { weight: number; count: number; r: number; g: number; b: number }

/**
 * The most represented color in RGBA pixel data. Pixels are grouped into 512 coarse buckets, and a
 * saturated pixel counts for up to three times a grey one, so a cover that is mostly grey with a
 * band of red gives the red. Near-black, near-white and see-through pixels have no hue worth
 * washing with and are skipped. Returns null when nothing is left, as for a cover that is only
 * black and white.
 */
export function dominantColor(data: ArrayLike<number>): Rgb | null {
  const buckets = new Map<number, Bucket>()
  for (let at = 0; at + 3 < data.length; at += 4) {
    const r = data[at] ?? 0
    const g = data[at + 1] ?? 0
    const b = data[at + 2] ?? 0
    if ((data[at + 3] ?? 0) < 128) continue
    const high = Math.max(r, g, b)
    const low = Math.min(r, g, b)
    if (high < 24 || low > 232) continue
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5)
    const bucket = buckets.get(key) ?? { weight: 0, count: 0, r: 0, g: 0, b: 0 }
    bucket.weight += 1 + (2 * (high - low)) / 255
    bucket.count += 1
    bucket.r += r
    bucket.g += g
    bucket.b += b
    buckets.set(key, bucket)
  }

  let best: Bucket | null = null
  for (const bucket of buckets.values()) if (!best || bucket.weight > best.weight) best = bucket
  if (!best) return null

  return { r: best.r / best.count, g: best.g / best.count, b: best.b / best.count, a: 1 }
}

/* Kept for the session so a track that comes round again is not read twice. Only a finished read
   is kept: a cover that failed to load may load next time. */
const cache = new Map<string, Rgb | null>()

/**
 * Reads the cover at `url` and resolves to its dominant color, or null on any failure: it does not
 * load, the canvas is unavailable, or the browser refuses the pixels. Covers come from
 * `/api/player/art/`, the page's own origin, so the canvas is never tainted.
 */
export function sampleCover(url: string): Promise<Rgb | null> {
  const known = cache.get(url)
  if (known !== undefined) return Promise.resolve(known)

  return new Promise((resolve) => {
    const image = new Image()
    image.onerror = () => resolve(null)
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = SAMPLE
        canvas.height = SAMPLE
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) {
          resolve(null)

          return
        }
        context.drawImage(image, 0, 0, SAMPLE, SAMPLE)
        const color = dominantColor(context.getImageData(0, 0, SAMPLE, SAMPLE).data)
        if (cache.size >= MAX_CACHED) {
          const oldest = cache.keys().next()
          if (!oldest.done) cache.delete(oldest.value)
        }
        cache.set(url, color)
        resolve(color)
      } catch {
        resolve(null)
      }
    }
    image.src = url
  })
}
