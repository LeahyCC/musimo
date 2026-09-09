import sherwin from 'butterchurn-presets/presets/converted/Flexi, martin + geiss - dedicated to the sherwin maxawow.json'

import type { StudioOptions } from './studio-options.ts'
import {
  desaturate,
  glsl,
  mergeStudioOptions,
  themeTints,
  trailGapScale,
  vec3,
} from './studio-options.ts'

// Retain Sherwin Maxawow's feedback and surface-lighting shaders, with continuous
// noise travel and slow vortices. All score states inhabit this same liquid.
// Cue transitions are visible events inside this one program: q30 carries
// transition activity (0 outside transition windows, peaking mid-window), driving
// a threshold-noise dissolve and a camera zoom-through burst.
// Studio options bake in as constants: theme re-hues the motif tints, motion
// scales the liquid clock, trails scales the feedback persistence. Defaults
// reproduce the authored strings exactly.
// Original: Flexi, martin + geiss, butterchurn-presets 2.4.7, MIT.
// See THIRD_PARTY_NOTICES.md for the original authors and package notices.
export function createJourneyPreset(options: StudioOptions = {}) {
  const resolved = mergeStudioOptions(options)
  // The liquid clock: authored .075, scaled by the motion option.
  const speed = glsl(0.075 * resolved.motion)
  // Feedback persistence: authored .997; trails scales the decay gap and the
  // result stays strictly below 1.
  const decay = glsl(Math.min(0.9995, 1 - 0.003 * trailGapScale(resolved.trails)))
  const [orbit, current, bloom] = themeTints[resolved.theme]
  const tint = `q21*${vec3(orbit)}+q22*${vec3(current)}+q23*${vec3(bloom)}`
  const preset = structuredClone(sherwin)
  preset.baseVals.gammaadj = 1.5
  preset.baseVals.wave_a = 0.002
  preset.baseVals.darken = 0
  preset.frame_eqs_str =
    preset.frame_eqs_str.replaceAll('a.time', `(a.time*${speed}+a.q28*.8)`) + 'a.q32=a.aspecty;'
  // Clock scaling only affects this preset's motion equations. The renderer and
  // controller still use exact media seconds, including through transitions.
  preset.pixel_eqs_str = preset.pixel_eqs_str
    .replaceAll('a.time', `(a.time*${speed}+a.q28*.8)`)
    .replace('a.r=div(a.bass,4)', 'a.r=.32+.055*a.q23')
    .replaceAll('a.bass', '(.13+.025*a.q26)')
    .replaceAll('a.mid', '(.12+.03*a.q22)')
    .replaceAll('a.treb', '(.1+.02*a.q23)')
  preset.warp = preset.warp
    .replace('rand_frame.xy', 'vec2(time*.00004,time*.000025)')
    .replace('tmpvar_3.x = bass;', 'tmpvar_3.x = 1.0 + q26 * .04;')
    .replace('tmpvar_3.y = treb;', 'tmpvar_3.y = 1.0 + q27 * .03;')
    .replace(
      'ret = tmpvar_4.xyz;',
      `
      vec2 seedUV=uv_orig*.015+vec2(time*.0001,-time*.00007);
      float seed=texture(sampler_noise_lq,seedUV).r;
      float light=.5+.5*sin(uv_orig.x*8.+uv_orig.y*5.+seed*5.+time*.035);
      ret=max(tmpvar_4.xyz*${decay},vec3(0.)) + vec3(light*light*.0009);
    `,
    )
  // ZOOM-THROUGH: every sampler_main read in comp goes through uvz, which
  // contracts toward the frame centre as q30 rises — the camera dives into the
  // frame mid-transition, then settles exactly when the window ends. Display
  // path only: a warp-path zoom would compound through the feedback texture and
  // break the seek reconstruction guarantees.
  preset.comp = preset.comp
    .replace(
      'shader_body { \n  vec2 uv1_1;',
      'shader_body { \n  vec2 uvz=((uv-.5)*(1.-q30*.15))+.5;\n  vec2 uv1_1;',
    )
    .replaceAll('texture (sampler_main, (uv', 'texture (sampler_main, (uvz')
    .replace('texture (sampler_main, uv)', 'texture (sampler_main, uvz)')
    .replace('((uv - 0.5) * 2.0)', '((uvz - 0.5) * 2.0)')
    .replace(
      'ret = tmpvar_6.xyz;',
      `
      vec2 p=(uv-.5)*aspect.xy;
      vec3 tint=${tint};
      float visibility=.72+.28*q24;
      float loudness=smoothstep(.01,.22,q26);
      vec3 material=max(tmpvar_6.xyz-vec3(.065),vec3(0.));
      ${desaturate(resolved.theme, 'material')}
      float vignette=1.-.42*smoothstep(.28,.82,length(p));
      ret=(1.-exp(-material*tint*1.5*visibility))*vignette*loudness;
      // NOISE DISSOLVE: a threshold sweeping a slowly drifting noise field drops
      // a growing share of pixels as q30 peaks mid-transition. Dropped pixels
      // re-sample the frame at a noise-displaced position, so the outgoing look
      // shatters into scattered fragments of itself that settle into the
      // incoming tint. The HDR feedback sample is normalized (x/(1+x)) before
      // display; every term stays bounded and nothing reaches the feedback.
      float grain=texture(sampler_noise_lq,uv*aspect.xy*5.+vec2(time*.00013,-time*.00009)).r;
      float grain2=texture(sampler_noise_lq,uv*aspect.xy*5.+vec2(-time*.00011,time*.00007)).g;
      float dropped=step(grain+.001,q30*.5);
      vec2 duv=(vec2(grain,grain2)-.5)*.3*q30;
      vec3 fragment=max(texture(sampler_main,uvz+duv).xyz,vec3(0.))*3.;
      fragment=fragment/(1.+fragment);
      ${desaturate(resolved.theme, 'fragment')}
      vec3 dust=(1.-exp(-fragment*tint*2.6*visibility))+vec3(tmpvar_5*grain)*tint*.9;
      ret=mix(ret,dust*vignette*loudness,dropped);
    `,
    )
  return preset
}
