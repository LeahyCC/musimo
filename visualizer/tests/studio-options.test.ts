import assert from 'node:assert/strict'
import test from 'node:test'

import {
  desaturate,
  glsl,
  mergeStudioOptions,
  parseStudioOptions,
  resolveSeed,
  serializeStudioOptions,
  themeDesat,
  themeTints,
  trailGapScale,
  vec3,
} from '../src/studio-options.ts'

test('default options merge to the authored visuals: Abyss, 1× motion, centred trails, score seed', () => {
  const merged = mergeStudioOptions()
  assert.deepEqual(merged, {
    theme: 'abyss',
    motion: 1,
    trails: 0.5,
    sensitivity: 1,
    seed: undefined,
  })
  // The trail gap multiplier at the centred slider position must be exactly 1
  // so the authored decays (.997, mix(.8,.93,loud)) bake byte-identically.
  assert.equal(trailGapScale(0.5), 1)
  assert.equal(1 - 0.003 * trailGapScale(0.5), 0.997)
  assert.equal(glsl(0.075 * merged.motion), '.075')
  assert.equal(glsl(1 - 0.003 * trailGapScale(merged.trails)), '.997')
  assert.equal(glsl(1 - 0.2 * trailGapScale(merged.trails)), '.8')
  assert.equal(glsl(1 - 0.07 * trailGapScale(merged.trails)), '.93')
  // The Abyss palette must reproduce the original tint expression.
  const [orbit, current, bloom] = themeTints.abyss
  assert.equal(
    `q21*${vec3(orbit)}+q22*${vec3(current)}+q23*${vec3(bloom)}`,
    'q21*vec3(.63,.94,1.)+q22*vec3(.65,.76,1.)+q23*vec3(1.,.82,.59)',
  )
  // Abyss anchors zero desaturation: mix(material, lum, 0.) === material exactly,
  // so the default build is visually identical to the authored shaders. Mono
  // anchors fully for a true grayscale silver, and Prism's split-saturation
  // default stays .55.
  assert.equal(themeDesat.abyss, 0)
  assert.equal(themeDesat.mono, 1)
  assert.equal(desaturate('abyss', 'material').endsWith(',0.);'), true)
  assert.equal(glsl(0.55 * (1 - themeDesat.abyss)), '.55')
  assert.equal(glsl(0.55 * (1 - themeDesat.mono)), '0.')
})

test('merge validates and clamps untrusted input', () => {
  assert.equal(mergeStudioOptions({ theme: 'neon' as never }).theme, 'abyss')
  assert.equal(mergeStudioOptions({ motion: 99 }).motion, 3)
  assert.equal(mergeStudioOptions({ motion: 0 }).motion, 0.3)
  assert.equal(mergeStudioOptions({ motion: Number.NaN }).motion, 1)
  assert.equal(mergeStudioOptions({ trails: -2 }).trails, 0)
  assert.equal(mergeStudioOptions({ trails: 4 }).trails, 1)
  assert.equal(mergeStudioOptions({ sensitivity: 99 }).sensitivity, 2.5)
  assert.equal(mergeStudioOptions({ seed: 3.5 }).seed, undefined)
  assert.equal(mergeStudioOptions({ seed: -1 }).seed, undefined)
  assert.equal(mergeStudioOptions({ seed: 2 ** 40 }).seed, undefined)
  assert.equal(mergeStudioOptions({ seed: 123456789 }).seed, 123456789)
})

test('trail gap scaling keeps every baked decay strictly below 1', () => {
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const gap = trailGapScale(t)
    assert(gap > 0, `gap at ${t}`)
    assert(1 - 0.003 * gap < 1, `dive decay at ${t}`)
    assert(1 - 0.07 * gap < 1, `phosphor high decay at ${t}`)
    assert(1 - 0.2 * gap < 1, `phosphor low decay at ${t}`)
  }
  // Longer trails (right) shrink the gap; shorter trails (left) grow it.
  assert(trailGapScale(0) > trailGapScale(0.5))
  assert(trailGapScale(1) < trailGapScale(0.5))
})

test('seed resolution: re-roll override beats the score, score beats the fallback', () => {
  assert.equal(resolveSeed({}, undefined), 271828)
  assert.equal(resolveSeed({}, 777), 777)
  assert.equal(resolveSeed({ seed: 42 }, 777), 42)
  assert.equal(resolveSeed({ seed: 42 }, undefined), 42)
})

test('persistence round-trips through JSON and survives corruption', () => {
  const merged = mergeStudioOptions({
    theme: 'ember',
    motion: 1.6,
    trails: 0.8,
    sensitivity: 1.9,
    seed: 20260908,
  })
  const restored = mergeStudioOptions(parseStudioOptions(serializeStudioOptions(merged)))
  assert.deepEqual(restored, merged)
  // A score-seed default serializes without a seed key and restores as undefined.
  const noSeed = mergeStudioOptions({ theme: 'mono' })
  assert(!serializeStudioOptions(noSeed).includes('seed'))
  assert.equal(
    mergeStudioOptions(parseStudioOptions(serializeStudioOptions(noSeed))).seed,
    undefined,
  )
  assert.deepEqual(parseStudioOptions(null), {})
  assert.deepEqual(parseStudioOptions('{not json'), {})
  assert.deepEqual(parseStudioOptions('[1,2]'), {})
  assert.deepEqual(parseStudioOptions('42'), {})
})

test('glsl literals match the authored shader style', () => {
  assert.equal(glsl(1), '1.')
  assert.equal(glsl(0.63), '.63')
  assert.equal(glsl(2.5), '2.5')
  assert.equal(glsl(0), '0.')
  assert.throws(() => glsl(Number.NaN))
  assert.throws(() => glsl(Number.POSITIVE_INFINITY))
})
