// Pieces the native studies share: relief lighting, a seed phase, the band
// smoother the kaleidoscope presets used and the accumulator wrap.

// Surface-relief lighting. This is the `relief` snippet from `effects-presets.ts`, after Flexi, martin +
// geiss's "dedicated to the sherwin maxawow" (butterchurn-presets 2.4.7, MIT;
// see THIRD_PARTY_NOTICES.md). It is copied rather than imported because
// `effects-presets.ts` imports a Butterchurn preset JSON at module scope, and a
// native study that imported from it would pull that whole package into the
// bundle for one string.
//
// The frame's own gradient bends two specular fields, so ridges in the material
// catch light. It leaves `g` (the gradient), `spec1`, `spec2` and `lit` in
// scope for the pass to grade.
export function relief(sampler: string): string {
  return `
  vec2 g=vec2(
    texture(${sampler},uv-vec2(texsize.z,0.)).x-texture(${sampler},uv+vec2(texsize.z,0.)).x,
    texture(${sampler},uv-vec2(0.,texsize.w)).x-texture(${sampler},uv+vec2(0.,texsize.w)).x);
  vec2 f1=.3*cos((uv-.5)*2.)-g;
  float spec1=clamp(.04/length(f1),0.,1.);
  vec2 f2=.3*cos(f1*12.)-9.*g;
  float spec2=clamp(.04/length(f2),0.,1.);
  vec3 lit=spec1+texture(${sampler},uv).xyz*12.*spec2;
`
}

// A seed-derived phase in radians, for drift terms that must differ between
// seeds. The `seed` uniform is already reduced modulo 2²⁴, so this stays exact.
export const SEED_PHASE = 'float ph=fract(seed*1e-4)*6.28318;'

// The band smoother the kaleidoscope presets used: square the band ratio, halve
// it, cap it well above anything music reaches, then follow it with a one-pole
// filter. Silence settles at 0.5, not 0, because a band level of 1.0 means
// "normal for this band" rather than "quiet".
export function smoothBand(previous: number, level: number): number {
  return 0.85 * previous + 0.15 * Math.min(level * level * 0.5, 4)
}

// Accumulators reach the shader as floats, where the fractional part stops
// resolving somewhere above 1e5. Every running total a study keeps goes through
// this before it is returned.
export const ACCUMULATOR_WRAP = 1e4

export function wrapAccumulator(value: number): number {
  return value % ACCUMULATOR_WRAP
}
