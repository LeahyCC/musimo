import { trailGapScale } from '../studio-options.ts'
import type { StudyManifest } from '../study-manifest.ts'
import { relief, SEED_PHASE, smoothBand, wrapAccumulator } from './common.ts'

// Kaleidoscope V3, ported from `kaleidoscope-v3-preset.ts` to the native
// renderer. The intent is unchanged; only the plumbing moved.
//
// Nothing is grown in a feedback loop. Each frame computes a kaleidoscopic IFS
// per pixel (fold, rotate, scale, offset, twelve generations) and colours it
// from orbit traps, the way fractal-flame and KIFS renders are made, so detail
// stays crisp at every scale instead of blurring one generation at a time.
//
// The screen reaches that fractal through the log-polar tunnel from V2: a
// Möbius map with two drifting singular points (two tunnel centres), then
// log-polar, so travel is a slide along one axis and the dive is endless in
// both directions.
//
// What the port changed:
//   - The 8-bit Butterchurn feedback becomes an RGBA16F persistent pass, so the
//     motion persistence no longer quantises.
//   - The preset's frame equations become the `frame` hook, and its q1..q5
//     become named uniforms.
//   - The baked studio constants become live uniforms, and the four things the
//     preset hardcoded become settings.
//   - Butterchurn's per-blur `scale`/`bias` terms are gone; the native blur
//     levels are already in the source pass's own range.

// The authored motion persistence, before the trails slider scales its gap.
const BASE_PERSISTENCE = 0.15

export const kaleidoscopeStudy: StudyManifest = {
  id: 'kaleidoscope3',
  name: 'Kaleidoscope V3',
  author: 'Musimo study · kaleidoscopic IFS, evaluated per pixel',
  settings: [
    // The multiplier on the log-polar angle. The tile is mirrored, so this many
    // wedges appear across a turn; 4 reproduces the original preset.
    { name: 'folds', label: 'Folds', min: 4, max: 16, step: 1, default: 8 },
    { name: 'depthSpeed', label: 'Depth', min: 0.2, max: 3, step: 0.05, default: 1 },
    { name: 'spinRate', label: 'Spin', min: -2, max: 2, step: 0.05, default: 1 },
    { name: 'glow', label: 'Glow', min: 0, max: 2, step: 0.05, default: 1 },
  ],
  blur: { source: 'fractal', levels: 3 },

  // The preset's frame equations. Pure: it reads only its arguments and its own
  // state, so a seek that replays the same frames with the same settings
  // reproduces the same uniforms.
  frame({ state, time, audio, settings, options }) {
    // Smoothed bands: bass swells the figure and drives travel, treble spins,
    // mids turn the fold angle.
    const bassSmooth = smoothBand(state.bassSmooth ?? 0, audio.bass)
    const midSmooth = smoothBand(state.midSmooth ?? 0, audio.mid)
    const trebSmooth = smoothBand(state.trebSmooth ?? 0, audio.treb)
    state.bassSmooth = bassSmooth
    state.midSmooth = midSmooth
    state.trebSmooth = trebSmooth
    // Travel mostly dives, with a slow periodic climb back out.
    const travel = wrapAccumulator(
      (state.travel ?? 0) +
        (0.0015 + 0.004 * bassSmooth) *
          options.motion *
          settings.depthSpeed *
          (0.35 + Math.sin(0.06 * time * options.motion)),
    )
    const spin = wrapAccumulator(
      (state.spin ?? 0) + (0.0005 + 0.0012 * trebSmooth) * options.motion * settings.spinRate,
    )
    // A hit envelope: jumps to the transient, then falls away over half a second.
    const pulse = Math.max(
      (state.pulse ?? 0) * 0.9,
      Math.min(1, (audio.bass - audio.bassAtt) * 2 * options.sensitivity),
    )
    state.travel = travel
    state.spin = spin
    state.pulse = pulse
    return {
      travel,
      spin,
      pulse,
      bassSmooth,
      midSmooth,
      // trailGapScale centres on the authored persistence: left keeps less of
      // the last frame, right keeps more, and the result stays below 1.
      persist: Math.min(
        0.5,
        Math.max(0.02, BASE_PERSISTENCE * (2 - trailGapScale(options.trails))),
      ),
    }
  },

  passes: [
    {
      name: 'fractal',
      output: 'buffer',
      persistent: true,
      glsl: `
  float t=time*motion;
  ${SEED_PHASE}
  // Tunnel: Möbius zero at -A and pole at -B, both drifting, then log-polar.
  vec2 A=vec2(1.+.35*sin(t*.023+ph),.3*cos(t*.031+ph));
  vec2 B=vec2(-1.+.3*cos(t*.019+ph*1.3),.35*sin(t*.027+ph));
  vec2 z=(uv_orig-.5)*2.*aspect.wz;
  vec2 n=z+A;
  vec2 d=z+B;
  vec2 m=vec2(n.x*d.x+n.y*d.y,n.y*d.x-n.x*d.y)/max(dot(d,d),1e-6);
  // The depth axis repeats every 2 units, so the log coefficient sets how many
  // tunnel rings cross the screen. The preset's .3 put barely half a ring in
  // frame, which read as a flat field rather than a dive.
  vec2 lp=vec2(atan(m.y,m.x)*.3183+spin*.3,1.1*log(length(m)+1e-6)-travel);
  // Mirrored wedges across, mirrored depth down: a tile in [-1,1]².
  vec2 c=abs(fract(vec2(lp.x*folds,lp.y)*.5)*2.-1.)*2.-1.;
  // Kaleidoscopic IFS. Bass swells the scale, mids turn the fold, the spin
  // accumulator rotates each generation a little. The scale also sets how fast
  // an orbit runs away and so how coarse the cells are: below about 2.2 the
  // whole tile falls under a pixel and the mandala reads as grey noise, which
  // is where the preset's own drift spent much of its time.
  float sc=2.45+.15*sin(t*.11+ph)+.15*clamp(bassSmooth,0.,1.5);
  vec2 off=vec2(1.,.55)+vec2(.2*sin(t*.07+ph),.2*cos(t*.05+ph));
  float th=.6+.3*sin(t*.043+ph)+.1*clamp(midSmooth,0.,1.5);
  mat2 R=mat2(cos(th),sin(th),-sin(th),cos(th));
  mat2 Ri=mat2(cos(th),-sin(th),sin(th),cos(th));
  float sa=spin*.15;
  mat2 Rs=mat2(cos(sa),sin(sa),-sin(sa),cos(sa));
  vec2 trapPt=vec2(.6*cos(t*.09+ph),.5*sin(t*.13+ph));
  float trapR=1e9;
  float trapX=1e9;
  float trapP=1e9;
  float hit=0.;
  float esc=12.;
  for(int i=0;i<12;i++){
    c=abs(c);
    c=Ri*abs(R*c);
    c=c*sc-off*(sc-1.);
    c=Rs*c;
    float dr=length(c);
    if(dr<trapR){trapR=dr;hit=float(i);}
    trapX=min(trapX,abs(c.x));
    trapP=min(trapP,length(c-trapPt));
    // The generation the orbit runs away at is the nesting depth, the same
    // signal an escape-time count carries. The orbit traps alone saturate
    // across most of the tile and leave a flat wash; this is what makes the
    // shells read as one inside another.
    if(dr>12.&&esc>11.5)esc=float(i)+1.-clamp(log2(log2(dr))*.5,0.,1.);
  }
  // Colour from the generation and the traps: a per-generation palette on the
  // closest layer, bright ridges, dark leading between cells, and a flash at
  // the moving trap point on hits. The trap distance carries only a little of
  // the hue, because it varies pixel to pixel inside a cell and leaning on it
  // turns every cell into colourless noise rather than a coloured shell.
  vec3 pal=.5+.5*cos(6.28318*(esc*.28+trapR*.12+vec3(0.,.33,.67))+t*.1+ph);
  // Half the wheel's chroma is enough to tell the shells apart. Leaving it at
  // full strength drowns the theme, which is what should be setting the mood.
  pal=mix(vec3(dot(pal,vec3(.299,.587,.114))),pal,.5);
  vec3 layer=.5+.5*cos(6.28318*(hit/12.)*vec3(1.,.9,.8)+vec3(0.,2.,4.)+ph);
  float skel=exp(-trapR*3.);
  float ridge=smoothstep(.35,0.,trapX);
  float flash=exp(-trapP*2.5)*(.3+.7*pulse);
  // Stepping on the generation gives each shell its own value, so a deeper one
  // sits visibly behind the one in front of it.
  float shell=.45+.55*fract(esc*.5);
  vec3 col=(pal*(.5+.8*skel)*shell+layer*ridge*.55+vec3(1.,.9,.7)*flash*.5)*1.5;
  col*=1.-.6*smoothstep(.04,0.,trapX);
  // The buffer holds a finished image, lightly persisted for motion.
  ret=mix(col,texture(sampler_fractal,uv_orig).xyz,persist);`,
    },
    {
      name: 'screen',
      output: 'screen',
      glsl: `
  float t=time*motion;
  ${SEED_PHASE}
  vec3 base=texture(sampler_fractal,uv).xyz;
  vec3 glowc=(texture(sampler_blur1,uv).xyz*.25
    +texture(sampler_blur2,uv).xyz*.35
    +texture(sampler_blur3,uv).xyz*.4)*glow;
  ${relief('sampler_fractal')}
  vec3 material=base*1.3+glowc*.8+base*spec2*3.+vec3(spec1*.15);
  material=mix(material,vec3(dot(material,vec3(.299,.587,.114))),desat);
  vec2 pv=(uv-.5)*aspect.xy;
  // Themes bias the palette rather than replace it; Mono still goes silver.
  vec3 tint=mix(vec3(1.),mix(tintA,tintB,.5+.5*sin(t*.03+atan(pv.y,pv.x)+ph)),.6);
  float veins=1.-.4*smoothstep(.03,.2,length(g)*4.);
  vec3 colour=1.-exp(-material*tint*2.);
  float vignette=1.-.35*smoothstep(.3,.9,length(pv));
  ret=colour*colour*vignette*veins;`,
    },
  ],
}
