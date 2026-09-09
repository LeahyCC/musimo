import { trailGapScale } from '../studio-options.ts'
import type { StudyManifest } from '../study-manifest.ts'
import { relief, SEED_PHASE, smoothBand, wrapAccumulator } from './common.ts'

// Liquid contours: a scalar field carried around by a curl-noise flow and drawn
// as iso-contour lines, the way a contour map draws a landscape.
//
// The flow is the perpendicular gradient of a scalar potential read from the
// smoothed noise texture. That makes it divergence-free, so the field swirls
// and folds instead of piling up into blobs, which is what a plain gradient
// flow would do. Two slow sources keep feeding it, the field decays, and the
// display pass finds the lines with a screen-space derivative so they stay one
// pixel wide however dense they are.

// The authored persistence, before the trails slider scales its gap.
const BASE_PERSISTENCE = 0.985

export const contoursStudy: StudyManifest = {
  id: 'contours',
  name: 'Liquid contours',
  author: 'Musimo study · curl-noise field, drawn as contour lines',
  settings: [
    { name: 'contours', label: 'Lines', min: 2, max: 40, step: 1, default: 14 },
    { name: 'flow', label: 'Flow', min: 0, max: 3, step: 0.05, default: 1 },
  ],

  frame({ state, audio, options }) {
    const bassSmooth = smoothBand(state.bassSmooth ?? 0, audio.bass)
    const trebSmooth = smoothBand(state.trebSmooth ?? 0, audio.treb)
    const drift = wrapAccumulator((state.drift ?? 0) + (0.6 + 0.5 * trebSmooth) * options.motion)
    const pulse = Math.max(
      (state.pulse ?? 0) * 0.92,
      Math.min(1, (audio.bass - audio.bassAtt) * 2 * options.sensitivity),
    )
    state.bassSmooth = bassSmooth
    state.trebSmooth = trebSmooth
    state.drift = drift
    state.pulse = pulse
    return {
      bassSmooth,
      trebSmooth,
      pulse,
      drift,
      decay: 1 - (1 - BASE_PERSISTENCE) * trailGapScale(options.trails),
    }
  },

  passes: [
    {
      name: 'field',
      output: 'buffer',
      persistent: true,
      glsl: `
  float t=time*motion;
  ${SEED_PHASE}
  // Curl of a scalar potential: the perpendicular gradient of the noise, which
  // is divergence-free, so the flow folds the field instead of compressing it.
  // The drift coefficients are chosen so that ACCUMULATOR_WRAP times either of
  // them is a whole number of texture periods. The noise texture repeats, so
  // the wrap then leaves the flow exactly where it was.
  vec2 q=uv*.35+vec2(drift*.0004,drift*.0002)+ph*.01;
  float e=.004;
  float px=texture(sampler_noise_mq,q+vec2(e,0.)).r;
  float mx=texture(sampler_noise_mq,q-vec2(e,0.)).r;
  float py=texture(sampler_noise_mq,q+vec2(0.,e)).r;
  float my=texture(sampler_noise_mq,q-vec2(0.,e)).r;
  vec2 velocity=vec2(py-my,mx-px)*(.6+.9*bassSmooth);
  // Semi-Lagrangian advection: read where this pixel's material came from.
  vec2 back=uv-velocity*flow*motion*.004;
  float previous=texture(sampler_field,back).x*decay;
  vec2 p=(uv-.5)*aspect.xy;
  // Two slow sources, so the flow always has new material to carry.
  vec2 s1=p-vec2(.6*sin(t*.13+ph),.4*cos(t*.19+ph));
  vec2 s2=p-vec2(.55*cos(t*.09+ph*1.7),.45*sin(t*.11+ph));
  // A faint bed everywhere as well, or wherever the flow has carried material
  // away is left with nothing for the contours to cut through.
  float bed=.003*(.4+texture(sampler_noise_mq,uv*.6+vec2(drift*.0002,0.)).g);
  float source=exp(-dot(s1,s1)*14.)*(.02+.16*pulse)
    +exp(-dot(s2,s2)*22.)*(.015+.03*trebSmooth)+bed;
  // The buffer is float, so the field needs its own ceiling.
  ret=vec3(clamp(previous+source,0.,8.));`,
    },
    {
      name: 'screen',
      output: 'screen',
      glsl: `
  ${relief('sampler_field')}
  float v=texture(sampler_field,uv).x;
  float s=v*contours;
  // fwidth is the field's change across one pixel, so a line stays one pixel
  // wide however steep the field is or however many lines are asked for.
  float w=max(fwidth(s),1e-4);
  float line=1.-smoothstep(w*.5,w*1.5,abs(fract(s)-.5));
  vec3 band=mix(tintA,tintB,fract(v*.5));
  vec3 material=band*(.12+.5*clamp(v,0.,1.5))+tintC*line*(.5+.7*spec2)+vec3(spec1*.12);
  material=mix(material,vec3(dot(material,vec3(.299,.587,.114))),desat);
  float veins=1.-.35*smoothstep(.02,.16,length(g)*4.);
  float vignette=1.-.35*smoothstep(.3,.95,length((uv-.5)*aspect.xy)*1.4);
  ret=(1.-exp(-material*1.8))*vignette*veins;`,
    },
  ],
}
