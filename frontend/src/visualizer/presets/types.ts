/**
 * What a preset is. One JSON file holds a scene, the numbers that scene
 * starts from, the post stack it wants, and the table saying which feature
 * drives which number. Nothing here touches the GPU; `parse.ts` turns an
 * unknown JSON value into one of these and `resolve.ts` turns one plus a
 * feature packet into the numbers a frame is drawn from.
 */
import type { PostKnob, PostParams } from '../post/params'
import type { SceneId } from '../scenes/catalog'
import type { AudioField, Curve, FluidKnob, ParticleKnob, RaymarchKnob } from './knobs'

/**
 * One row of the mapping table: a feature, bent by a curve and multiplied by
 * a gain, added to the preset's resting value for that knob.
 *
 *   value = sceneParams[to] + gain × curve(feature[from])
 *
 * `to` is one of the scene's own knobs or a dotted post target such as
 * `bloom.intensity`. Several rows may point at the same knob; they add.
 */
export type Mapping<K extends string> = {
  from: AudioField
  to: K | PostKnob
  gain: number
  curve: Curve
}

type Shape<S extends SceneId, K extends string> = {
  /** Stable, used as the storage value and in the picker's option values. */
  id: string
  /** What the picker shows, and what the debug overlay names. */
  name: string
  scene: S
  /** The resting value of every knob the scene offers. */
  sceneParams: Readonly<Record<K, number>>
  /**
   * The whole stack. In the file it is a patch, so a preset need only say
   * what moves; the parser resolves it over the stack's defaults.
   */
  postParams: PostParams
  audioMapping: readonly Mapping<K>[]
}

export type ParticlePreset = Shape<'particles', ParticleKnob>
export type FluidPreset = Shape<'fluid', FluidKnob>
export type RaymarchPreset = Shape<'raymarch', RaymarchKnob>

/** A scene and the knobs it offers always agree, because this is a union. */
export type Preset = ParticlePreset | FluidPreset | RaymarchPreset
