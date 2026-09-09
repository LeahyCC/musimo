import { trailGapScale } from '../studio-options.ts'
import type { StudyManifest } from '../study-manifest.ts'

// The authored feedback persistence, before the trails slider scales its gap.
const BASE_PERSISTENCE = 0.93
// Travel is a running accumulator. Wrapping it keeps it far below the ~1e5
// where a highp float stops resolving the fractional part the shader needs.
const TRAVEL_WRAP = 4096

// One persistent feedback pass zooming and rotating into itself, plus a screen
// pass that tints, adds the middle blur level as glow and vignettes.
export const tunnelStudy: StudyManifest = {
  id: 'tunnel',
  name: 'Native tunnel',
  author: 'Musimo study · feedback tunnel',
  settings: [
    { name: 'pull', label: 'Tunnel pull', min: 0.004, max: 0.06, step: 0.002, default: 0.028 },
    { name: 'folds', label: 'Folds', min: 2, max: 12, step: 1, default: 6 },
    { name: 'glow', label: 'Glow', min: 0, max: 2, step: 0.05, default: 0.5 },
  ],
  blur: { source: 'feedback', levels: 3 },

  // Pure: reads only its arguments and its own state, so a reconstruction from
  // the same starting frame reproduces the same uniforms.
  frame({ state, time, audio, options }) {
    const travel =
      ((state.travel ?? 0) + (0.35 + 0.3 * (audio.volAtt - 1)) * options.motion) % TRAVEL_WRAP
    state.travel = travel
    return {
      // trailGapScale centres on the authored decay: left shortens the trails,
      // right lengthens them, and every result stays strictly below 1.
      decay: 1 - (1 - BASE_PERSISTENCE) * trailGapScale(options.trails),
      travel,
      // Rings are born close to the centre; the feedback zoom is what carries
      // them outward, so a large radius here would leave the middle empty.
      ringRadius: 0.1 + 0.025 * Math.sin(time * 0.13) + 0.02 * (audio.midAtt - 1),
    }
  },

  passes: [
    {
      name: 'feedback',
      output: 'buffer',
      persistent: true,
      glsl: `
  vec2 p = (uv - .5) * aspect.xy;
  float spin = time * motion * .06;
  float c = cos(spin), s = sin(spin);
  vec2 back = mat2(c, -s, s, c) * p * (1. - pull);
  vec3 previous = texture(sampler_feedback, back / aspect.xy + .5).rgb * decay;

  float radius = length(p);
  float angle = atan(p.y, p.x);
  float flare = clamp((bass - bass_att) * 4. * sensitivity, 0., 1.);
  // Narrow, or the ring is as wide as its own radius and reads as a blob.
  float ring = exp(-pow((radius - ringRadius) * 90., 2.));
  // Pulsing the source turns a steady cone into separate rings receding, which
  // is what reads as depth once the feedback carries them out.
  float pulse = .15 + .85 * pow(.5 + .5 * sin(travel * 1.2), 4.);
  float petals = .5 + .5 * sin(angle * folds + travel * .7);
  float grain = texture(sampler_noise_mq, vec2(angle * .16, travel * .004) + seed * .0001).r;

  vec3 source = mix(tintC, tintA, petals) * ring * pulse * (.35 + flare * 1.8);
  source += tintB * ring * grain * (.06 + flare * .45);
  // A small core keeps the vanishing point lit; the zoom empties it otherwise.
  source += tintA * exp(-pow(radius * 22., 2.)) * (.04 + flare * .3);
  ret = max(previous + source, vec3(0.));`,
    },
    {
      name: 'screen',
      output: 'screen',
      glsl: `
  vec3 lit = texture(sampler_feedback, uv).rgb;
  lit += texture(sampler_blur2, uv).rgb * glow * .45;
  // The feedback buffer is HDR, so bring it into range before tinting, or the
  // tint is applied to values the display never shows.
  lit = lit / (1. + lit);
  lit *= mix(tintA, tintB, clamp(length(uv - .5) * 1.7, 0., 1.));
  lit = mix(lit, vec3(dot(lit, vec3(.299, .587, .114))), desat);
  float vignette = smoothstep(1.15, .3, length((uv - .5) * aspect.xy) * 1.4);
  ret = lit * vignette;`,
    },
  ],
}
