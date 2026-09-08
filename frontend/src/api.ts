import { z } from 'zod'

export const namingSchema = z.object({ path: z.string() })

export const jobSchema = z.object({
  id: z.string(),
  batch_id: z.string().default(''),
  batch_label: z.string().default(''),
  album_id: z.number().default(0),
  track_id: z.number(),
  format: z.enum(['original', 'm4a', 'opus', 'mp3']),
  target: z.string(),
  stage: z.string(),
  desired: z.string(),
  meta: z.object({
    id: z.number(),
    title: z.string(),
    artist: z.string(),
    album: z.string(),
    art: z.string(),
    duration: z.number(),
  }),
  candidates: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      artist: z.string(),
      duration: z.number(),
      score: z.number(),
      topic: z.boolean(),
      reason: z.string(),
    }),
  ),
  selected: z.string(),
  check_match: z.boolean(),
  attempts: z.number(),
  retry_at: z.number(),
  progress: z.number(),
  downloaded: z.number(),
  total: z.number(),
  speed: z.number(),
  eta: z.number().nullable(),
  error_code: z.string(),
  error: z.string(),
  retryable: z.boolean(),
  tool_tail: z.string(),
  tool_version: z.string(),
  warnings: z.array(z.string()),
  final_path: z.string(),
  codec: z.string(),
  actual_bitrate: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
  hidden: z.boolean(),
})
export type DownloadJob = z.infer<typeof jobSchema>
export const controlsSchema = z.object({ paused: z.boolean(), source_paused: z.boolean() })
export const jobsSchema = z.object({ jobs: z.array(jobSchema), controls: controlsSchema })
export const historySchema = z.object({ jobs: z.array(jobSchema), total: z.number() })
export const commandSchema = z.object({ controls: controlsSchema, errors: z.array(z.string()) })

export const resultSchema = z.object({
  id: z.number(),
  kind: z.enum(['track', 'album', 'artist']),
  title: z.string(),
  artist: z.string(),
  artist_id: z.number(),
  album: z.string(),
  album_id: z.number(),
  art: z.string(),
  duration: z.number(),
  year: z.number().nullable(),
  explicit: z.boolean(),
  preview: z.string(),
  isrc: z.string(),
  popularity: z.number(),
  track_count: z.number(),
  record_type: z.string(),
  ownership: z.enum(['owned', 'partial', 'missing']),
  matched_paths: z.array(z.string()),
  owned_count: z.number(),
  coverage_verified: z.boolean(),
  disc: z.number(),
  position: z.number(),
})
export type MusicResult = z.infer<typeof resultSchema>
export const searchPageSchema = z.object({
  items: z.array(resultSchema),
  total: z.number(),
  next_index: z.number().nullable(),
  cached: z.boolean(),
})
export const albumSchema = z.object({
  album: resultSchema,
  tracks: z.array(resultSchema),
  label: z.string(),
  duration: z.number(),
  complete: z.boolean(),
})
export const artistSchema = z.object({
  artist: z.object({ id: z.number(), name: z.string(), art: z.string() }),
  items: z.array(resultSchema),
  next_index: z.number().nullable(),
})
export const artistTopSchema = z.object({ tracks: z.array(resultSchema) })
export const yearsSchema = z.record(z.string(), z.number().nullable())
export const previewSchema = z.object({ url: z.string(), source: z.string() })
export const librarySchema = z.object({
  status: z.string(),
  walked: z.number(),
  indexed: z.number(),
  errors: z.number(),
  elapsed: z.number(),
  detail: z.string(),
  total_files: z.number(),
  roots: z.array(z.string()),
})

const field = <T extends z.ZodType>(value: T) =>
  z.object({ value, origin: z.string(), locked: z.boolean() })

export const settingsSchema = z.object({
  library_label: field(z.string()),
  output_format: field(z.enum(['original', 'm4a', 'opus', 'mp3'])),
  concurrency: field(z.number()),
  max_attempts: field(z.number()),
  retry_base_seconds: field(z.number()),
  retry_cap_seconds: field(z.number()),
  destination: field(z.string()),
  naming_template: field(z.string()),
  navidrome_url: field(z.string()),
  navidrome_mode: field(z.enum(['off', 'watcher', 'api'])),
  navidrome_library_id: field(z.number()),
})
export type Settings = z.infer<typeof settingsSchema>
export type SettingKey = keyof Settings

const healthSchema = z.object({
  status: z.string(),
  version: z.string(),
  uptime_seconds: z.number(),
  phase: z.number(),
})
export const sourceSchema = z.object({
  source: z.string(),
  status: z.string(),
  latency_ms: z.number().nullable(),
  detail: z.string(),
  checked_at: z.string(),
})
export const diagnosticsSchema = z.object({
  health: healthSchema,
  versions: z.record(z.string(), z.string()),
  disks: z.array(
    z.object({
      path: z.string(),
      free_bytes: z.number().nullable(),
      total_bytes: z.number().nullable(),
      exists: z.boolean(),
      writable: z.boolean(),
    }),
  ),
  sources: z.array(sourceSchema),
  events: z.array(
    z.object({
      id: z.number(),
      kind: z.string(),
      created_at: z.string(),
      payload: z.unknown(),
    }),
  ),
  database: z.object({
    mode: z.string(),
    schema: z.number(),
    retained_events: z.number(),
  }),
})
export const snapshotSchema = z.object({
  settings: settingsSchema,
  cursor: z.number(),
  jobs: z.array(jobSchema),
  controls: controlsSchema,
})

export async function api<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, init)
  const data: unknown = await response.json()
  if (!response.ok) {
    const problem = z.object({ detail: z.string() }).safeParse(data)
    throw new Error(problem.success ? problem.data.detail : `Request failed (${response.status})`)
  }
  return schema.parse(data)
}
