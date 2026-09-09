import sherwin from 'butterchurn-presets/presets/converted/Flexi, martin + geiss - dedicated to the sherwin maxawow.json'

import type { Rgb, StudioOptions, Theme } from './studio-options.ts'
import {
  desaturate,
  glsl,
  mergeStudioOptions,
  themeDesat,
  trailGapScale,
  vec3,
} from './studio-options.ts'

// Three audition studies grafted onto Sherwin Maxawow's feedback and
// surface-lighting shaders. Each keeps the renderer deterministic: no
// rand_frame or rand_preset, motion derives from exact media time and the
// audio variables only. All effects are pure functions of frame content,
// so seek reconstruction and replay stay consistent with the engine rules.
// Studio options bake in as constants: theme re-hues each study's tint mix
// (keeping its character), trails scales Phosphor's ghost persistence and
// sensitivity scales each study's onset response. Defaults reproduce the
// authored strings exactly.
// Original: Flexi, martin + geiss, butterchurn-presets 2.4.7, MIT.
// See THIRD_PARTY_NOTICES.md for the original authors and package notices.

type Preset = typeof sherwin

// Per-study tint pairs, re-hued per theme. Abyss is each study's authored palette.
const phosphorTints: Record<Theme, [Rgb, Rgb]> = {
  abyss: [
    [0.25, 0.8, 0.6],
    [0.35, 0.6, 1],
  ],
  ember: [
    [0.85, 0.5, 0.2],
    [1, 0.35, 0.18],
  ],
  ultraviolet: [
    [0.55, 0.35, 0.95],
    [0.85, 0.3, 0.9],
  ],
  mono: [
    [0.5, 0.5, 0.5],
    [0.8, 0.8, 0.8],
  ],
}
const kaleidoscopeTints: Record<Theme, [Rgb, Rgb]> = {
  abyss: [
    [0.72, 0.38, 1],
    [0.28, 0.78, 0.9],
  ],
  ember: [
    [1, 0.42, 0.18],
    [0.9, 0.68, 0.3],
  ],
  ultraviolet: [
    [0.8, 0.3, 1],
    [0.45, 0.45, 0.95],
  ],
  mono: [
    [0.65, 0.65, 0.65],
    [0.4, 0.4, 0.4],
  ],
}
const prismTints: Record<Theme, Rgb> = {
  abyss: [0.75, 0.9, 1.1],
  ember: [1.1, 0.8, 0.55],
  ultraviolet: [0.9, 0.65, 1.15],
  mono: [1, 1, 1],
}

function basePreset(): Preset {
  const preset = structuredClone(sherwin)
  preset.baseVals.darken = 0
  preset.baseVals.wave_a = 0.002
  // Replace the per-frame random noise offset with a deterministic time drift.
  preset.warp = preset.warp.replace(
    'rand_frame.xy',
    'vec2(time*.00004+mod(uv_orig.x*7.0,1.0),time*.000025)',
  )
  return preset
}

// Phosphor Memory — kicks burn slow-fading ghost trails into the frame while
// the ambient liquid keeps moving and decaying quickly. Two time constants in
// one feedback texture: moved pixels fade fast, still pixels fade slowly.
export function createPhosphorPreset(options: StudioOptions = {}): Preset {
  const resolved = mergeStudioOptions(options)
  const preset = basePreset()
  const sensitivity = glsl(resolved.sensitivity)
  // Ghost persistence: authored mix(.8,.93,loud); trails scales each decay gap,
  // bounded strictly below 1.
  const gap = trailGapScale(resolved.trails)
  const ghostLow = glsl(Math.min(0.999, 1 - 0.2 * gap))
  const ghostHigh = glsl(Math.min(0.999, 1 - 0.07 * gap))
  const [tintA, tintB] = phosphorTints[resolved.theme]
  // The authored ghost threshold (prevn > .5) sits above the range this
  // liquid's feedback actually reaches, so the ghost term contributes nothing
  // and a ghost-decay-only trails control would be invisible. Trails therefore
  // also scales the liquid's ambient subtractive fade — the live persistence
  // mechanism — with ×1 at the centred default, leaving today's exact image.
  const fade = glsl(gap)
  preset.warp = preset.warp
    .replace(' - (0.0008 + (', ' - ((0.0008 + (')
    .replace('* 0.02)).xyz);', `* 0.02)) * ${fade}).xyz);`)
  preset.warp = preset.warp.replace(
    'ret = tmpvar_4.xyz;',
    `
      // Wideband onsets: bass kicks, but also mid movement and treble
      // transients, so quiet sections stay alive. The sensitivity option
      // scales the response after clamping, keeping it bounded.
      float onset=max(clamp((bass-bass_att)*4.,0.,1.),
                      clamp((mid-mid_att)*2.5+(treb-treb_att)*3.,0.,1.)*.7);
      onset=clamp(onset*${sensitivity},0.,1.);
      float loud=clamp(vol_att*.8,0.,1.);
      // Trail memory: normalize into display range FIRST — the feedback runs
      // in HDR, so a raw threshold keeps everything and the additive term
      // blows out. Only bright cores persist, as a gentle static imprint.
      vec3 prev=texture(sampler_main,uv_orig).xyz;
      vec3 prevn=prev/(1.+prev);
      vec3 core=max(prevn-vec3(.5),vec3(0.));
      vec3 ghost=core*mix(${ghostLow},${ghostHigh},loud)*.3;
      // Shimmer floor: faint noise glints, stronger when the mix is quiet.
      vec2 seedUV=uv_orig*.015+vec2(time*.0001,-time*.00007);
      float seed=texture(sampler_noise_lq,seedUV).r;
      float glint=.5+.5*sin(uv_orig.x*9.-uv_orig.y*6.+seed*6.+time*.21);
      glint*=glint;
      ret=tmpvar_4.xyz+ghost+tmpvar_4.xyz*(onset*.06)
          +vec3(glint*.0016*(.3+.7*(1.-loud)));
    `,
  )
  preset.comp = preset.comp.replace(
    'ret = tmpvar_6.xyz;',
    `
      // Linear grade only. No tone-map compression: the surface relief lives
      // in HDR range, and squashing it flattens the liquid.
      vec2 p=(uv-.5)*aspect.xy;
      vec3 material=max(tmpvar_6.xyz-vec3(.06),vec3(0.));
      ${desaturate(resolved.theme, 'material')}
      vec3 tint=mix(${vec3(tintA)},${vec3(tintB)},clamp(uv.y+.2*sin(time*.05),0.,1.));
      float vignette=1.-.45*smoothstep(.26,.85,length(p));
      ret=material*tint*vignette;
    `,
  )
  return preset
}

// Kaleidoscope Tides — the liquid folds into a breathing N-fold mirror. The
// fold count drifts with time and swells with volume; the fold axis turns
// slowly and the folded image is lit by the same surface-lighting field, so
// shards stay continuous with the underlying forms.
export function createKaleidoscopePreset(options: StudioOptions = {}): Preset {
  const resolved = mergeStudioOptions(options)
  const preset = basePreset()
  const sensitivity = glsl(resolved.sensitivity)
  const [tintA, tintB] = kaleidoscopeTints[resolved.theme]
  preset.comp = preset.comp.replace(
    'ret = tmpvar_6.xyz;',
    `
      vec2 kp=(uv-.5)*aspect.xy;
      float krad=length(kp);
      float kang=atan(kp.y,kp.x);
      float folds=5.+2.*sin(time*.043)+1.5*clamp((vol_att-1.)*${sensitivity},0.,1.);
      float seg=6.28318/folds;
      float fa=mod(kang-time*.021,seg);
      fa=abs(fa-seg*.5);
      vec2 kuv=.5+krad*vec2(cos(fa),sin(fa))/aspect.xy;
      // Relight the folded sample with the same lighting field (tmpvar_5).
      vec3 shard=texture(sampler_main,kuv).xyz*12.*tmpvar_5;
      float tide=.55+.45*sin(time*.07+krad*4.);
      float blendm=clamp(.3+.45*tide+.35*clamp((mid-1.)*${sensitivity},0.,1.),0.,1.);
      vec3 material=max(mix(tmpvar_6.xyz,shard*1.2,blendm)-vec3(.13),vec3(0.));
      ${desaturate(resolved.theme, 'material')}
      vec3 tint=mix(${vec3(tintA)},${vec3(tintB)},.5+.5*sin(time*.03+kang));
      vec3 col=1.-exp(-material*tint*2.6);
      float vignette=1.-.45*smoothstep(.26,.85,krad);
      ret=col*col*vignette;
    `,
  )
  return preset
}

// Prism Fracture — chromatic aberration driven by onsets. At rest the image is
// nearly clean; kicks and hats split the spectrum along a slowly rotating,
// radially growing axis so transients read as a glass shatter of color.
export function createPrismPreset(options: StudioOptions = {}): Preset {
  const resolved = mergeStudioOptions(options)
  const preset = basePreset()
  const sensitivity = glsl(resolved.sensitivity)
  preset.comp = preset.comp.replace(
    'ret = tmpvar_6.xyz;',
    `
      float onset=clamp(((bass-bass_att)*5.+(treb-treb_att)*2.)*${sensitivity},0.,1.);
      vec2 pd=(uv-.5)*aspect.xy;
      float pr=length(pd);
      vec2 pdir=pd/max(pr,.0001);
      float pang=time*.05;
      vec2 prot=vec2(cos(pang),sin(pang));
      float mag=(.0012+onset*.013)*(.35+.65*pr);
      vec2 off=(pdir*.7+prot*.3)*mag/aspect.xy;
      vec3 split;
      split.x=texture(sampler_main,uv+off).x;
      split.y=texture(sampler_main,uv).y;
      split.z=texture(sampler_main,uv-off).z;
      // Grade a coherent base and the fractured version, then crossfade by
      // onset — the recirculating frame stays clean at rest, so the fracture
      // arrives as a transient shatter instead of permanent color drift.
      vec3 baseSample=texture(sampler_main,uv).xyz;
      vec3 materialBase=max(tmpvar_5+baseSample*6.*tmpvar_5-vec3(.10),vec3(0.));
      vec3 materialSplit=max(tmpvar_5+split*6.*tmpvar_5-vec3(.10),vec3(0.));
      materialSplit+=onset*tmpvar_5*.06;
      // Anchor both grades to luminance so the palette stays icy; the split
      // keeps only part of its hue, so fringes read as prismatic flashes
      // rather than drifting color fields.
      float lumB=dot(materialBase,vec3(.299,.587,.114));
      float lumS=dot(materialSplit,vec3(.299,.587,.114));
      materialSplit=mix(vec3(lumS),materialSplit,${glsl(0.55 * (1 - themeDesat[resolved.theme]))});
      vec3 tint=${vec3(prismTints[resolved.theme])};
      vec3 colBase=1.-exp(-vec3(lumB)*tint*3.);
      vec3 colSplit=1.-exp(-materialSplit*tint*3.);
      vec3 col=mix(colBase,colSplit,clamp(.15+.85*onset,0.,1.));
      float vignette=1.-.45*smoothstep(.28,.85,pr*1.4);
      ret=col*col*vignette;
    `,
  )
  return preset
}
