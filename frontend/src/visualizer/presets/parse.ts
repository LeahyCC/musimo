/**
 * Turn an unknown JSON value into a `Preset`, or throw saying what is wrong
 * with it. The preset files are compiled in rather than fetched, so a failure
 * here is a mistake in the repository and not something a person can cause;
 * `index.ts` parses all six at load and lets the error out, which is what
 * lets the rest of the visualizer trust the shape.
 *
 * Everything arrives as `unknown` and is narrowed on the way through. The
 * messages name the file and the path inside it, because a preset is a wall
 * of numbers and "expected a number" on its own is no help.
 */
import { defaultPostParams, isPostKnob, POST_KNOBS, POST_LANES } from '../post/params'
import type { PostParams, PostStage } from '../post/params'
import { isSceneId, SCENE_IDS } from '../scenes/catalog'
import { AUDIO_FIELDS, CURVES, FLUID_KNOBS, PARTICLE_KNOBS, RAYMARCH_KNOBS } from './knobs'
import type { AudioField, Curve } from './knobs'
import type { Mapping, Preset } from './types'

const POST_STAGES: readonly PostStage[] = ['feedback', 'bloom', 'chromatic', 'tonemap', 'grain']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const list = (values: readonly string[]) => values.join(', ')

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'object') return 'an object'
  return String(value)
}

// Declared rather than assigned, so TypeScript treats a call as the end of
// the branch and narrows what follows it.
function fail(source: string, path: string, message: string): never {
  throw new Error(`${source}: ${path} ${message}`)
}

function readNumber(value: unknown, source: string, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    fail(source, path, `expected a finite number, got ${describe(value)}`)
  return value
}

function readBoolean(value: unknown, source: string, path: string): boolean {
  if (typeof value !== 'boolean') fail(source, path, `expected true or false`)
  return value
}

function readString(value: unknown, source: string, path: string): string {
  if (typeof value !== 'string' || !value)
    fail(source, path, `expected a name, got ${describe(value)}`)
  return value
}

/**
 * Every knob the scene offers, all of them required. A preset is the whole
 * resting state of a scene rather than a patch over one, so a missing knob is
 * a mistake and not a silent fall back to whatever the last preset left.
 */
function readKnobs<K extends string>(
  knobs: readonly K[],
  value: unknown,
  source: string,
  path: string,
): Record<K, number> {
  if (!isRecord(value)) fail(source, path, `expected an object of ${knobs.length} numbers`)
  const out = {} as Record<K, number>
  for (const knob of knobs) {
    if (!(knob in value)) fail(source, `${path}.${knob}`, 'is missing')
    out[knob] = readNumber(value[knob], source, `${path}.${knob}`)
  }

  for (const key of Object.keys(value))
    if (!(knobs as readonly string[]).includes(key))
      fail(source, `${path}.${key}`, `is not a knob of this scene; it has ${list(knobs)}`)
  return out
}

function readMapping<K extends string>(
  knobs: readonly K[],
  value: unknown,
  source: string,
  path: string,
): Mapping<K>[] {
  if (!Array.isArray(value)) fail(source, path, `expected an array, got ${describe(value)}`)
  return value.map((row: unknown, index: number) => {
    const at = `${path}[${index}]`
    if (!isRecord(row)) fail(source, at, `expected an object, got ${describe(row)}`)
    const from = readString(row.from, source, `${at}.from`)
    if (!(AUDIO_FIELDS as readonly string[]).includes(from))
      fail(source, `${at}.from`, `is not a feature; the fields are ${list(AUDIO_FIELDS)}`)
    const to = readString(row.to, source, `${at}.to`)
    if (!(knobs as readonly string[]).includes(to) && !isPostKnob(to))
      fail(
        source,
        `${at}.to`,
        `is neither a knob of this scene (${list(knobs)}) nor a post target (${list(POST_KNOBS)})`,
      )
    const curve = row.curve === undefined ? 'linear' : readString(row.curve, source, `${at}.curve`)
    if (!(CURVES as readonly string[]).includes(curve))
      fail(source, `${at}.curve`, `is not a curve; they are ${list(CURVES)}`)
    return {
      from: from as AudioField,
      to: to as K,
      gain: readNumber(row.gain, source, `${at}.gain`),
      curve: curve as Curve,
    }
  })
}

/**
 * The stack the preset wants. In the file it is a patch, so a preset that
 * only moves the bloom says only that; here it is resolved over the stack's
 * defaults into the whole thing, which is what the renderer hands over and
 * modulates. Stage names, field names and the three bloom weights are all
 * checked, because a typo in a preset is otherwise silent.
 */
function readPost(value: unknown, source: string, path: string): PostParams {
  if (!isRecord(value)) fail(source, path, `expected an object, got ${describe(value)}`)
  const params = defaultPostParams()
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'enabled') {
      params.enabled = readBoolean(raw, source, `${path}.enabled`)
      continue
    }

    if (!(POST_STAGES as readonly string[]).includes(key))
      fail(source, `${path}.${key}`, `is not a post stage; they are ${list(POST_STAGES)}`)
    readStage(key as PostStage, raw, source, `${path}.${key}`, params)
  }

  return params
}

function readStage(
  stage: PostStage,
  value: unknown,
  source: string,
  path: string,
  into: PostParams,
) {
  if (!isRecord(value)) fail(source, path, `expected an object, got ${describe(value)}`)
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'enabled') {
      into[stage].enabled = readBoolean(raw, source, `${path}.enabled`)
      continue
    }

    if (stage === 'bloom' && key === 'weights') {
      if (!Array.isArray(raw) || raw.length !== 3)
        fail(source, `${path}.weights`, 'expected three numbers, widest last')
      into.bloom.weights = [
        readNumber(raw[0], source, `${path}.weights[0]`),
        readNumber(raw[1], source, `${path}.weights[1]`),
        readNumber(raw[2], source, `${path}.weights[2]`),
      ]
      continue
    }

    const knob = `${stage}.${key}`
    if (!isPostKnob(knob))
      fail(
        source,
        `${path}.${key}`,
        `is not a field of ${stage}; the stack has ${list(POST_KNOBS)}`,
      )
    POST_LANES[knob].write(into, readNumber(raw, source, `${path}.${key}`))
  }
}

const KEYS = ['id', 'name', 'scene', 'sceneParams', 'postParams', 'audioMapping']

/** `source` names the file, so a failure says which preset is wrong. */
export function parsePreset(value: unknown, source: string): Preset {
  if (!isRecord(value)) fail(source, 'the preset', `expected an object, got ${describe(value)}`)
  for (const key of Object.keys(value))
    if (!KEYS.includes(key)) fail(source, key, 'is not part of a preset')
  const id = readString(value.id, source, 'id')
  const name = readString(value.name, source, 'name')
  const scene = readString(value.scene, source, 'scene')
  if (!isSceneId(scene)) fail(source, 'scene', `is not a scene; they are ${list(SCENE_IDS)}`)
  const postParams = readPost(value.postParams, source, 'postParams')

  if (scene === 'fluid')
    return {
      id,
      name,
      scene,
      sceneParams: readKnobs(FLUID_KNOBS, value.sceneParams, source, 'sceneParams'),
      postParams,
      audioMapping: readMapping(FLUID_KNOBS, value.audioMapping, source, 'audioMapping'),
    }

  if (scene === 'raymarch')
    return {
      id,
      name,
      scene,
      sceneParams: readKnobs(RAYMARCH_KNOBS, value.sceneParams, source, 'sceneParams'),
      postParams,
      audioMapping: readMapping(RAYMARCH_KNOBS, value.audioMapping, source, 'audioMapping'),
    }

  return {
    id,
    name,
    scene,
    sceneParams: readKnobs(PARTICLE_KNOBS, value.sceneParams, source, 'sceneParams'),
    postParams,
    audioMapping: readMapping(PARTICLE_KNOBS, value.audioMapping, source, 'audioMapping'),
  }
}
