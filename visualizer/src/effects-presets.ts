import sherwin from 'butterchurn-presets/presets/converted/Flexi, martin + geiss - dedicated to the sherwin maxawow.json'

import type { Rgb, StudioOptions, Theme } from './studio-options.ts'
import {
  desaturate,
  glsl,
  mergeStudioOptions,
  resolveSeed,
  themeDesat,
  trailGapScale,
  vec3,
} from './studio-options.ts'

// Three studies, each a single effect with its own feedback rule, motion
// equations and light sources. They share one thing with Sherwin Maxawow: its
// surface-relief lighting, used on the display path only so every study keeps
// the same crispness. Nothing else is inherited: no Sherwin vortices, no inner
// border ring, no wave.
//
// Every study stays deterministic. There is no rand_frame or rand_preset; all
// drift is a function of media time, the baked seed phase and the audio
// variables, so seek reconstruction and replay behave as the engine expects.
//
// Studio options bake in as constants. Theme re-hues each study's tints, motion
// scales every clock, trails scales each study's own persistence, sensitivity
// scales its onset response and the seed sets the phase every drift starts
// from. Defaults reproduce the authored look.
// Relief lighting after Flexi, martin + geiss, butterchurn-presets 2.4.7, MIT.
// See THIRD_PARTY_NOTICES.md for the original authors and package notices.

export type Preset = typeof sherwin

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
export const kaleidoscopeTints: Record<Theme, [Rgb, Rgb]> = {
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

// The constants every study bakes from the options.
export type Baked = {
  theme: Theme
  speed: string // motion multiplier, GLSL literal
  jsSpeed: string // the same, for the JS motion equations
  sensitivity: string
  gap: number // trails multiplier on each study's decay gap
  phase: string // seed phase in radians, GLSL literal
  jsPhase: string
}

export function bake(options: StudioOptions): Baked {
  const resolved = mergeStudioOptions(options)
  const seed = resolveSeed(resolved)
  const phase = ((seed % 997) / 997) * Math.PI * 2
  return {
    theme: resolved.theme,
    speed: glsl(resolved.motion),
    jsSpeed: String(resolved.motion),
    sensitivity: glsl(resolved.sensitivity),
    gap: trailGapScale(resolved.trails),
    phase: glsl(phase),
    jsPhase: String(Number(phase.toFixed(6))),
  }
}

// Sherwin's relief lighting: the frame's own gradient bends two specular
// fields, so ridges in the material catch light. Leaves `lit` for the grade.
export const relief = `
  vec2 g=vec2(
    texture(sampler_main,uv-vec2(texsize.z,0.)).x-texture(sampler_main,uv+vec2(texsize.z,0.)).x,
    texture(sampler_main,uv-vec2(0.,texsize.w)).x-texture(sampler_main,uv+vec2(0.,texsize.w)).x);
  vec2 f1=.3*cos((uv-.5)*2.)-g;
  float spec1=clamp(.04/length(f1),0.,1.);
  vec2 f2=.3*cos(f1*12.)-9.*g;
  float spec2=clamp(.04/length(f2),0.,1.);
  vec3 lit=spec1+texture(sampler_main,uv).xyz*12.*spec2;
`

// A deterministic per-pixel dither for the decay floor, so fading material
// breaks up into grain instead of banding. Drifts with time, never random.
export const dither = (t: string) => `
  float dither=texture(sampler_noise_lq,uv_orig*.6+vec2(${t}*.0001,-${t}*.00007)).g-.5;
`

export function study(
  eqs: { init: string; frame: string; pixel: string },
  warp: string,
  comp: string,
  baseVals: Record<string, number>,
): Preset {
  const preset = structuredClone(sherwin)
  // No wave, no inner border ring, no darken: each study supplies its own sources.
  Object.assign(preset.baseVals, { darken: 0, wave_a: 0, ib_a: 0, ...baseVals })
  preset.init_eqs_str = eqs.init
  preset.frame_eqs_str = eqs.frame
  preset.pixel_eqs_str = eqs.pixel
  preset.warp = ` shader_body { \n${warp}\n }`
  preset.comp = ` shader_body { \n${comp}\n }`
  return preset
}

// Phosphor Memory: a phosphor screen. Kicks burst at the eye of one slow
// vortex; the burst is carried off and fades within a second, but wherever it
// was bright it leaves a still imprint that holds for seconds. Two time
// constants in one texture: moving material decays fast, still material is
// peak-held and decays slowly.
export function createPhosphorPreset(options: StudioOptions = {}): Preset {
  const b = bake(options)
  const [tintA, tintB] = phosphorTints[b.theme]
  // Ghost hold per frame. Trails scales the decay gap; loud passages hold longer.
  const holdQuiet = glsl(Math.min(0.9995, 1 - 0.012 * b.gap))
  const holdLoud = glsl(Math.min(0.9995, 1 - 0.005 * b.gap))
  const S = b.jsSpeed
  const P = b.jsPhase
  return study(
    {
      init: 'a.cx1=.5;a.cy1=.5;a.d=0;a.dir=0;',
      frame: 'a.wave_a=0;',
      // One wandering vortex whose pull follows the bass. The eye's path is
      // mirrored in the warp shader so bursts land at its centre.
      pixel:
        `a.cx1=.5+.2*Math.sin(.11*a.time*${S}+${P});a.cy1=.5+.16*Math.cos(.17*a.time*${S}+${P});` +
        'a.d=Math.sqrt((a.x-a.cx1)*(a.x-a.cx1)+(a.y-a.cy1)*(a.y-a.cy1));' +
        'a.dir=(.05+.22*a.bass)*(.2025-a.d*a.d)*.9;' +
        'a.dx=a.d<.45?Math.sin(a.y-a.cy1)*a.dir:0;a.dy=a.d<.45?-Math.sin(a.x-a.cx1)*a.dir:0;' +
        'a.zoom=1.0015;',
    },
    `
      float t=time*${b.speed};
      vec2 p=(uv_orig-.5)*aspect.xy;
      float onset=max(clamp((bass-bass_att)*4.,0.,1.),
                      clamp((mid-mid_att)*2.5+(treb-treb_att)*3.,0.,1.)*.7);
      onset=clamp(onset*${b.sensitivity},0.,1.);
      float loud=clamp(vol_att*.8,0.,1.);
      ${dither('t')}
      // Moving material: the frame's own colour nudges where it is read from,
      // which is what makes it flow. It fades within a second.
      vec3 here=texture(sampler_main,uv).xyz;
      vec2 push=(here.xy-.4)*(-.003+.02*clamp(bass-1.,0.,1.));
      vec3 moved=texture(sampler_main,uv+push).xyz;
      moved=max(moved*.955-vec3(.0015+dither*.002),vec3(0.));
      // Still material: read unmoved, peak-held, decaying over seconds. The
      // gate keeps dim residue from holding forever.
      vec3 still=texture(sampler_main,uv_orig).xyz;
      float glow=dot(still,vec3(.299,.587,.114));
      vec3 ghost=still*mix(${holdQuiet},${holdLoud},loud)*smoothstep(.02,.12,glow);
      // Sources: each hit bursts at the vortex eye; a faint shimmer keeps quiet
      // passages alive.
      vec2 eye=vec2(.2*sin(t*.11+${b.phase}),.16*cos(t*.17+${b.phase}))*aspect.xy;
      float d=length(p-eye);
      vec3 burst=vec3(.9,1.,1.)*onset*smoothstep(.38,0.,d)*.35;
      float seed=texture(sampler_noise_lq,uv_orig*.015+vec2(t*.0001,-t*.00007)).r;
      float glint=.5+.5*sin(p.x*9.-p.y*6.+seed*6.+t*.21+${b.phase});
      glint*=glint;
      vec3 shimmer=vec3(glint*.0018*(.3+.7*(1.-loud)));
      vec3 ember=vec3(.002*smoothstep(.45,0.,d));
      // Peak hold: whichever is brighter survives, so imprints never add up.
      ret=max(moved+burst+shimmer+ember,ghost);
    `,
    `
      ${relief}
      vec2 p=(uv-.5)*aspect.xy;
      // Linear grade: the imprints live in HDR and a tone curve would flatten them.
      vec3 material=max(lit-vec3(.06),vec3(0.));
      ${desaturate(b.theme, 'material')}
      vec3 tint=mix(${vec3(tintA)},${vec3(tintB)},clamp(uv.y+.2*sin(time*${b.speed}*.05+${b.phase}),0.,1.));
      float vignette=1.-.45*smoothstep(.26,.85,length(p));
      ret=material*tint*vignette;
    `,
    { warp: 0.015, warpscale: 0.2 },
  )
}

// A rotation of RGB about the grey axis, as a GLSL mat3 literal. Applied every
// frame in the feedback, it makes each descending layer a different hue.
export function hueMatrix(theta: number): string {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const o = (1 - c) / 3
  const q = s / Math.sqrt(3)
  const rows = [
    [c + o, o - q, o + q],
    [o + q, c + o, o - q],
    [o - q, o + q, c + o],
  ]
  // GLSL takes columns.
  const columns = [0, 1, 2].map((j) => rows.map((row) => glsl(row[j])).join(','))
  return `mat3(${columns.join(',')})`
}

// Kaleidoscope Tides: a mandala with depth. Every frame is an eight-fold
// mirror of the last, read through a scale that breathes in and out (bass
// pulls it in), so the figure is a tunnel of itself. A half-size copy of the
// whole is folded back into the centre, giving nested self-similar detail. A
// second, six-fold mirror around a satellite point inside the wedge grows
// smaller figures around the main one, and the vanishing point wanders
// between them (the other voids). Each layer descends with a hue shift, so
// depth reads as colour bands. Sources are a textured seed cell in the wedge
// and a rim that flashes on hits; the folds replicate them into the pattern.
export function createKaleidoscopePreset(options: StudioOptions = {}): Preset {
  const b = bake(options)
  const [tintA, tintB] = kaleidoscopeTints[b.theme]
  const decay = glsl(Math.min(0.9995, 1 - 0.008 * b.gap))
  const hue = hueMatrix(0.012)
  const S = b.jsSpeed
  const P = b.jsPhase
  return study(
    {
      init: 'a.d=0;',
      frame: 'a.wave_a=0;',
      // A slow spiral turn only; depth and drift live in the shader.
      pixel: `a.zoom=1.;a.rot=.0025*Math.sin(.05*a.time*${S}+${P});`,
    },
    `
      float t=time*${b.speed};
      vec2 p=(uv-.5)*aspect.xy;
      float onset=clamp(max((bass-bass_att)*4.,(mid-mid_att)*3.)*${b.sensitivity},0.,1.);
      float pull=clamp((bass_att-1.)*${b.sensitivity},0.,1.);
      float breathe=sin(t*.11+${b.phase});
      ${dither('t')}
      // The vanishing point wanders, sometimes out to where a satellite sits.
      vec2 drift=vec2(sin(t*.037+${b.phase}),cos(t*.029+${b.phase}*1.7))*.12*(.6+.4*sin(t*.013));
      // Depth: below 1 the last frame is read larger, so we dive in; above 1
      // it recedes. Breathing plus the bass decides which way.
      float scale=1.-.012*breathe-.02*pull;
      // Eight-fold mirror around the drifting centre and a turning axis.
      vec2 v=p-drift;
      float r=length(v);
      float ka=atan(v.y,v.x);
      float seg=6.28318/8.;
      float axis=t*.017+${b.phase};
      float fa=abs(mod(ka-axis,seg)-seg*.5);
      vec2 w=r*vec2(cos(fa),sin(fa));
      // Satellite: a six-fold mirror around a point inside the wedge, taking
      // hold only near it, so smaller figures grow off the main one.
      vec2 sat=vec2(.34,.11);
      vec2 ws=w-sat;
      float rs=length(ws);
      float segs=6.28318/6.;
      float fs=abs(mod(atan(ws.y,ws.x)+t*.05,segs)-segs*.5);
      vec2 w2=sat+rs*vec2(cos(fs),sin(fs));
      w=mix(w,w2,.85*smoothstep(.28,.08,rs));
      // Back to the screen, through the depth scale.
      vec2 rw=vec2(w.x*cos(axis)-w.y*sin(axis),w.x*sin(axis)+w.y*cos(axis));
      vec2 k=.5+(drift+rw*scale)/aspect.xy;
      vec3 folded=texture(sampler_main,k).xyz;
      // Nesting: read the whole figure at half size into the centre.
      vec2 k2=.5+(drift+rw*2.2)/aspect.xy;
      float nest=.3*smoothstep(.55,.25,length(rw));
      vec3 c=mix(folded,texture(sampler_main,k2).xyz,nest);
      // Each layer descends with a hue shift.
      c=${hue}*c;
      c=max(c*${decay}-vec3(.0006+dither*.0015),vec3(0.));
      // Sources, placed in wedge coordinates so the folds replicate them.
      vec3 srcColour=.5+.5*vec3(sin(t*.31+${b.phase}),sin(t*.31+${b.phase}+2.09),sin(t*.31+${b.phase}+4.19));
      float cell=smoothstep(.09,0.,length(w-vec2(.22,.06)))*texture(sampler_noise_lq,w*3.+t*.02).r;
      float rim=onset*smoothstep(.05,0.,abs(r-.18-.06*breathe));
      ret=c+srcColour*(cell*.012+rim*.35)+vec3(.0008);
    `,
    `
      ${relief}
      vec2 p=(uv-.5)*aspect.xy;
      float krad=length(p);
      float kang=atan(p.y,p.x);
      vec3 material=max(lit-vec3(.13),vec3(0.));
      ${desaturate(b.theme, 'material')}
      vec3 tint=mix(${vec3(tintA)},${vec3(tintB)},.5+.5*sin(time*${b.speed}*.03+kang+${b.phase}));
      // Dark veins along steep edges give the stained-glass leading.
      float veins=1.-.5*smoothstep(.03,.2,length(g)*4.);
      vec3 col=1.-exp(-material*tint*2.6);
      float vignette=1.-.45*smoothstep(.26,.85,krad);
      ret=col*col*vignette*veins;
    `,
    { warp: 0.004, warpscale: 0.1 },
  )
}

// Prism Fracture: glass. A slow refraction field bends every read, and the
// spectrum splits in the feedback itself: each frame red slides outward and
// blue inward, a little at rest and much more on a hit, so fringes pile up on
// transients and fade as the material decays. Hits shatter into spokes from
// the centre that the split then carries out in colour.
export function createPrismPreset(options: StudioOptions = {}): Preset {
  const b = bake(options)
  const decay = glsl(Math.min(0.9995, 1 - 0.03 * b.gap))
  const splitSaturation = glsl(0.55 * (1 - themeDesat[b.theme]))
  const S = b.jsSpeed
  const P = b.jsPhase
  return study(
    {
      init: 'a.d=0;',
      frame: 'a.wave_a=0;',
      // Constant slow turn, a slight outward zoom, and a glass ripple that
      // bends the material in two directions.
      pixel:
        `a.rot=.0012*${S};a.zoom=1.002;` +
        `a.dx=.0025*Math.sin(a.y*11.+.4*a.time*${S}+${P})*(.5+.5*a.mid_att);` +
        `a.dy=.0025*Math.cos(a.x*9.-.3*a.time*${S}+${P})*(.5+.5*a.mid_att);`,
    },
    `
      float t=time*${b.speed};
      vec2 p=(uv-.5)*aspect.xy;
      float pr=length(p);
      float pang=atan(p.y,p.x);
      vec2 pdir=p/max(pr,.0001);
      float onset=clamp(((bass-bass_att)*5.+(treb-treb_att)*2.)*${b.sensitivity},0.,1.);
      ${dither('t')}
      vec2 refr=(texture(sampler_noise_lq,uv_orig*2.5+vec2(t*.012,-t*.009)+${b.phase}*.1).xy-.5)*.004;
      vec2 base=uv+refr;
      float spread=(.0008+onset*.010)*(.35+.65*pr);
      vec2 off=pdir*spread/aspect.xy;
      vec3 c;
      c.x=texture(sampler_main,base+off).x;
      c.y=texture(sampler_main,base).y;
      c.z=texture(sampler_main,base-off).z;
      c=max(c*${decay}-vec3(.0007+dither*.0015),vec3(0.));
      // Sources: spokes on hits, and a faint centre glow so the glass stays lit.
      float spokes=pow(.5+.5*sin(pang*7.+t*.2+${b.phase}),24.)*smoothstep(.55,.05,pr);
      vec3 shard=vec3(onset*spokes*.6);
      vec3 glow=vec3(.0012*smoothstep(.5,0.,pr)+.0004);
      ret=c+shard+glow;
    `,
    `
      ${relief}
      vec2 p=(uv-.5)*aspect.xy;
      float pr=length(p);
      vec3 material=max(lit-vec3(.10),vec3(0.));
      // Anchor to luminance so the glass stays icy; the fringes keep part of
      // their hue and read as prismatic flashes rather than colour fields.
      float lumin=dot(material,vec3(.299,.587,.114));
      material=mix(vec3(lumin),material,${splitSaturation});
      vec3 tint=${vec3(prismTints[b.theme])};
      vec3 col=1.-exp(-material*tint*3.);
      float vignette=1.-.45*smoothstep(.28,.85,pr*1.4);
      ret=col*col*vignette;
    `,
    { warp: 0.01, warpscale: 0.15 },
  )
}
