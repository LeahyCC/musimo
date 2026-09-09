import type { StudyManifest } from '../study-manifest.ts'
import { SEED_PHASE, smoothBand } from './common.ts'

// Julia spiral: an escape-time Julia set falling forever into itself.
//
// The look Colin picked out is a classic deep zoom: bulbous lobes with black
// cores, hard posterised colour bands with no gradient between them, spiral
// arms winding into the zoom centre, the palette cycling as the zoom goes on,
// and a busy grainy field of tiny lobes between the big ones. The bands here
// are the theme's tints rather than a raw rainbow, and how many make one cycle
// is a setting.
//
// The endless part is the set's own self-similarity. A Julia set is invariant
// under z → β + λ(z − β) at a repelling fixed point β, where λ is the
// derivative there. Zooming in by |λ| and turning by arg(λ) therefore lands on
// the same picture, so the dive can run forever inside one level and hand over
// to the next without a seam and without ever exhausting float precision.
// arg(λ) is also where the spiral arms come from: every level arrives rotated.
// Two levels are cross-faded, because the invariance is exact only in the limit
// at β and merely close further out.
//
// Escaping takes about one more iteration per level, so the band index carries
// the level back out. That is what keeps the bands still while the palette
// slides, which is what the reference does as its zoom goes on.

// c is parameterised by the multiplier μ at the attracting fixed point,
// c = μ/2 − μ²/4. Keeping |μ| just under 1 puts c just inside the main cardioid,
// where the set has a real interior: that interior is the reference's black
// core, and everything outside it is the banded field. It also hands the
// repelling fixed point over for free: β = 1 − μ/2 and λ = 2 − μ, no square root.
//
// μ walks an arc of the unit circle rather than the whole of it. Near μ = 1 the
// multiplier λ approaches 1, which would leave the dive with no step to take,
// and near μ = −1 it turns real, which would leave the spiral with no turn.
const MU_CENTRE = 1.6
const MU_SWING = 0.7
// How many levels below the screen the dive sits, as a GLSL literal. The
// picture converges as this grows, so anything past a few levels only costs
// iterations; three is where the filigree along the boundary arrives.
const DIVE_DEPTH = '3.'

export const juliaStudy: StudyManifest = {
  id: 'julia',
  name: 'Julia spiral',
  author: 'Musimo study · escape-time Julia, self-similar dive',
  settings: [
    { name: 'zoomSpeed', label: 'Zoom', min: 0.1, max: 3, step: 0.05, default: 1 },
    // A log-spiral twist of the screen. It is applied to the screen alone, the
    // same way at every level, so it costs the dive nothing.
    { name: 'spiral', label: 'Spiral', min: -3, max: 3, step: 0.05, default: 1.2 },
    { name: 'bands', label: 'Bands', min: 3, max: 16, step: 1, default: 8 },
  ],

  frame({ state, audio, settings, options }) {
    const bassSmooth = smoothBand(state.bassSmooth ?? 0, audio.bass)
    const midSmooth = smoothBand(state.midSmooth ?? 0, audio.mid)
    state.bassSmooth = bassSmooth
    state.midSmooth = midSmooth
    // Counted in levels, so only its fractional part ever reaches the shader.
    const zoom =
      ((state.zoom ?? 0) + (0.002 + 0.003 * bassSmooth) * options.motion * settings.zoomSpeed) %
      1024
    // c walks a slow circle, and bass pushes it outwards, where the filaments
    // thin and the arms grow longer. Its period is exactly 2π, so the wrap
    // cannot show up in the picture.
    const orbit =
      ((state.orbit ?? 0) + (0.0012 + 0.002 * midSmooth) * options.motion) % (2 * Math.PI)
    const palette = ((state.palette ?? 0) + 0.0007 * options.motion) % 1
    state.zoom = zoom
    state.orbit = orbit
    state.palette = palette

    // Bass carries μ towards the cardioid boundary, where the interior grows its
    // filigree; it must never reach it, or the black core swallows the frame.
    const modulus = 1.002 + 0.004 * Math.min(1, bassSmooth * 0.5)
    const angle = MU_CENTRE + MU_SWING * Math.sin(orbit)
    const muX = modulus * Math.cos(angle)
    const muY = modulus * Math.sin(angle)
    return {
      zoom,
      palette,
      cx: muX / 2 - (muX * muX - muY * muY) / 4,
      cy: muY / 2 - (muX * muY) / 2,
      // The repelling fixed point β, which the dive falls into.
      ax: 1 - muX / 2,
      ay: -muY / 2,
      // λ = 2 − μ, as a log modulus and an argument: one level of the dive, and
      // the turn every level arrives with.
      levelStep: Math.log(Math.hypot(2 - muX, muY)),
      turn: Math.atan2(-muY, 2 - muX),
    }
  },

  passes: [
    {
      name: 'screen',
      output: 'screen',
      glsl: `
  ${SEED_PHASE}
  vec2 p=(uv-.5)*aspect.wz*1.6;
  // A log-spiral twist of the screen: the further out, the more it turns.
  float wa=spiral*log(max(length(p),1e-6))+ph;
  vec2 pw=vec2(p.x*cos(wa)-p.y*sin(wa),p.x*sin(wa)+p.y*cos(wa));
  float f=fract(zoom);
  vec2 c=vec2(cx,cy);
  vec3 col=vec3(0.);
  for(int layer=0;layer<2;layer++){
    // Layer 0 fades in over the level and layer 1 fades out, arriving exactly
    // where layer 0 leaves from. That handover is what makes the dive endless.
    float lev=f+float(layer);
    float ang=-lev*turn;
    vec2 w=vec2(ax,ay)
      +vec2(pw.x*cos(ang)-pw.y*sin(ang),pw.x*sin(ang)+pw.y*cos(ang))*exp(-(lev+${DIVE_DEPTH})*levelStep);
    float n=0.;
    for(int i=0;i<96;i++){
      w=vec2(w.x*w.x-w.y*w.y,2.*w.x*w.y)+c;
      if(dot(w,w)>256.)break;
      n+=1.;
    }
    // Smooth iteration count, so a band edge is a clean curve rather than a
    // staircase of whole iterations. Meaningless where the point never escaped.
    float sn=n-log2(max(log2(max(length(w),1.0001)),1e-4));
    float cycle=(sn-lev)/bands+palette;
    // Posterise: the reference has hard bands, not a gradient.
    float idx=floor(fract(cycle)*bands)/bands;
    // The reference's rainbow becomes the theme's three tints: the band index
    // walks around them, and a second, faster cycle sets how bright each band
    // sits, so neighbours stay distinct without the hue leaving the theme.
    // .159 is 1/2π: the seed phase enters as a fraction of a turn around the
    // three tints rather than as radians.
    float hue=fract(idx+ph*.159)*3.;
    vec3 banded=(hue<1.?mix(tintA,tintB,hue):hue<2.?mix(tintB,tintC,hue-1.):mix(tintC,tintA,hue-2.))
      *(.3+.85*(.5+.5*cos(6.28318*idx*2.+ph)));
    // A fine ruling of one ripple per iteration, so the far field, where whole
    // bands are wide, still carries the shape of the escape contours.
    banded*=.85+.15*cos(6.28318*sn);
    // A thin dark leading edge at every band boundary, the way the reference
    // separates its lobes with black rather than letting two colours touch.
    float edge=fract(cycle*bands);
    banded*=.2+.8*smoothstep(0.,.22,min(edge,1.-edge)*2.);
    // The core is the set itself: points that never escaped stay black.
    col+=banded*step(n,95.5)*(layer==0?f:1.-f);
  }
  col=mix(col,vec3(dot(col,vec3(.299,.587,.114))),desat);
  ret=col*(1.-.3*smoothstep(.3,1.,length((uv-.5)*aspect.xy)*1.4));`,
    },
  ],
}
