import { glsl, trailGapScale } from '../studio-options.ts'
import type { StudyManifest } from '../study-manifest.ts'

// Dive journey, ported from `journey-preset.ts` to the native renderer.
//
// The GLSL in the two passes below is derived from "Flexi, martin + geiss -
// dedicated to the sherwin maxawow", by Flexi, martin and geiss, shipped in
// butterchurn-presets 2.4.7 under the MIT licence. Its warp and comp shader
// bodies, its frame and pixel equations and its base values are reproduced
// here with the Dive replacements `journey-preset.ts` made to them, so the
// study survives the removal of that package. See
// `public/THIRD_PARTY_NOTICES.txt`.
//
// The intent is unchanged: one liquid that every score state inhabits, with
// cue transitions as visible events inside the same program.
//
// What the port changed:
//   - Butterchurn computed the warp source coordinate once per vertex on a 48
//     by 36 mesh and interpolated it across each cell. Here the same arithmetic
//     runs per pixel, which is finer than the mesh rather than different from it.
//   - The 8-bit feedback becomes an RGBA16F persistent pass, so the decay floor
//     no longer quantises. The authored values are unchanged; nothing was
//     re-tuned for the wider range.
//   - The score's q21..q30 and the studio options become uniforms instead of
//     constants baked into preset text, so the Customize panel is live.
//   - Sherwin's inner border was geometry drawn over the feedback; it is a band
//     in this pass now.
//   - Three of the preset's base values were already inert and are gone:
//     `gammaadj` and `darken` only act in Butterchurn's built-in comp, and
//     Sherwin ships its own, so neither ever ran. `decay` 1 likewise belongs to
//     the built-in warp. The wave at `wave_a` .002 and the preset's disabled
//     shapes are dropped, which also leaves the `wave_*` frame equations
//     without a consumer, and `a.q32` was only ever read as `aspect` here.
//
// The score reaches the shaders through the frame hook below, mapped exactly as
// the Butterchurn path mapped its q variables:
//
//   q21 orbit        q26 energy
//   q22 current      q27 texture
//   q23 bloom        q28 variation
//   q24 intensity    q29 progress
//   q25 onset × sensitivity        q30 transition activity

// The liquid clock, before the motion option scales it.
const BASE_SPEED = 0.075
// Sherwin sets ib_a 1 and leaves ib_size at Butterchurn's default .01. The
// border geometry made a ring of half that width in uv, inside the frame edge.
const BORDER_BAND = 0.005
// Butterchurn's noise textures are 256 square; the warp body reads their texel
// size through a uniform we do not carry.
const NOISE_TEXEL = 1 / 256

const idleJourney = {
  orbit: 0,
  current: 0,
  bloom: 0,
  intensity: 0,
  onset: 0,
  energy: 0,
  texture: 0,
  variation: 0,
  progress: 0,
  transitionActivity: 0,
}

export const diveStudy: StudyManifest = {
  id: 'dive',
  name: 'Dive journey',
  author: 'Based on Flexi, martin + geiss’s Sherwin Maxawow',

  // Pure, and free of accumulators: every value here is a function of the media
  // position, the score at that position and the studio options, so a seek
  // reproduces its destination without replaying anything.
  frame({ time, options, journey }) {
    const score = journey ?? idleJourney
    // The preset's own clock. Butterchurn's equations read `a.time`; the Dive
    // replacement scaled it and added a per-cue offset so a variation change
    // slides the whole liquid rather than restarting it.
    const t = time * BASE_SPEED * options.motion + score.variation * 0.8
    return {
      q21: score.orbit,
      q22: score.current,
      q23: score.bloom,
      q24: score.intensity,
      q25: score.onset * options.sensitivity,
      q26: score.energy,
      q27: score.texture,
      q28: score.variation,
      q29: score.progress,
      q30: score.transitionActivity,
      // Feedback persistence: authored .997, with trails scaling the decay gap.
      // The result stays strictly below 1 at both ends of the slider.
      decay: Math.min(0.9995, 1 - 0.003 * trailGapScale(options.trails)),
      // Sherwin's frame equations, which only ever set the border colour and
      // the dropped wave's.
      ibR: 0.3 * Math.sin(5 * t) + 0.7,
      ibG: 0.3 * Math.sin(4 * t) + 0.3,
      ibB: 0.5 * Math.sin((4 * t) / 3) + 0.5,
    }
  },

  passes: [
    {
      name: 'liquid',
      output: 'buffer',
      persistent: true,
      glsl: `
  float t=time*${glsl(BASE_SPEED)}*motion+q28*.8;

  // --- Butterchurn's warp mesh, evaluated per pixel ---------------------
  // Its vertex positions negate the grid's y, so the mesh coordinate that the
  // equations below expect runs the opposite way from uv_orig.
  vec2 asp=aspect.xy;
  float mx=uv_orig.x*2.-1.;
  float my=1.-uv_orig.y*2.;
  // The coordinates the pixel equations see, in Butterchurn's 0..1 space.
  vec2 pe=vec2(mx*.5*asp.x+.5,my*-.5*asp.y+.5);

  // The preset's three vortices, with the Dive replacements: the radius rides
  // the bloom weight, and the three band levels became q-driven constants so
  // the flow follows the score rather than the transients.
  float vr=.32+.055*q23;
  vec2 cen[3];
  cen[0]=vec2(.5+.2*sin(.618*t),.5+.2*cos(1.618*t));
  cen[1]=vec2(.5+.3*sin(2.618*t),.5+.3*cos(3.14*t));
  cen[2]=vec2(.5+.4*sin(-2.618*t),.5+.4*cos(-1.14*t));
  float str[3];
  str[0]=(.13+.025*q26);
  str[1]=-(.12+.03*q22);
  str[2]=-(.1+.02*q23);
  vec2 dxy=vec2(0.);
  for(int i=0;i<3;i++){
    vec2 rel=pe-cen[i];
    float d=length(rel);
    // The preset's above(d, r) test: outside its own radius a vortex adds
    // nothing at all, which is what gives the flow its soft-edged cells.
    if(d>vr) continue;
    float dir=str[i]*(vr*vr-d*d)*.3;
    dxy+=vec2(sin(rel.y)*dir,-sin(rel.x)*dir);
  }

  // zoom is 1, so Butterchurn's zoom2 term is 1 whatever zoomexp is; cx, cy are
  // .5 and sx, sy are 1, so its centre and scale step is the identity; rot is 0.
  // What is left is the aspect mapping, the warp sinusoids and the vortices.
  float u=mx*.5*asp.x+.5;
  float v=-my*.5*asp.y+.5;
  float wsi=1./.107;
  float wf0=11.68+4.*cos(t*1.413+10.);
  float wf1=8.77+3.*cos(t*1.113+7.);
  float wf2=10.54+3.*cos(t*1.233+3.);
  float wf3=11.49+4.*cos(t*.933+5.);
  u+=.01*.0035*sin(t*.333+wsi*(mx*wf0-my*wf3));
  v+=.01*.0035*cos(t*.375-wsi*(mx*wf2+my*wf1));
  u+=.01*.0035*cos(t*.753-wsi*(mx*wf1-my*wf2));
  v+=.01*.0035*sin(t*.825+wsi*(mx*wf0+my*wf3));
  u-=dxy.x;
  v-=dxy.y;
  vec2 mesh=(vec2(u,v)-.5)/asp+.5;

  // --- Sherwin's warp body ----------------------------------------------
  // Its per-frame random pair became a slow drift, so the grain travels with
  // the liquid instead of flickering, and stays a function of media time.
  vec2 nuv=uv_orig*texsize.xy*${glsl(NOISE_TEXEL * 2)}+vec2(time*.00004,time*.000025);
  vec2 uv1=mesh+(texture(sampler_noise_lq,nuv).xy-.5)*texsize.zw;
  // The original read bass and treb here; the Dive replacement holds the
  // relief lift just above its resting value and lets energy and texture
  // breathe it.
  vec2 amp=vec2(1.+q26*.04,1.+q27*.03);
  vec2 probe=2.*uv1-uv_orig+texsize.zw;
  vec3 lifted=texture(sampler_liquid,uv1+(texture(sampler_liquid,probe).xy-.4)
    *(-.004+.04*clamp(amp-1.,0.,1.))).xyz
    -(vec3(.0008)+(texture(sampler_noise_lq,nuv).xyz-.5)*.02);

  // The seeded light Dive adds in place of the original's plain assignment: a
  // slow standing wave, displaced by the noise field, feeding the decay a
  // little energy so the liquid never settles to black.
  vec2 seedUV=uv_orig*.015+vec2(time*.0001,-time*.00007);
  float ns=texture(sampler_noise_lq,seedUV).r;
  float light=.5+.5*sin(uv_orig.x*8.+uv_orig.y*5.+ns*5.+time*.035);
  ret=max(lifted*decay,vec3(0.))+vec3(light*light*.0009);

  // --- The inner border -------------------------------------------------
  // Butterchurn drew this as alpha-blended geometry after the warp and before
  // the comp read the buffer, so it both shows and feeds back. ib_a is 1, which
  // makes the blend a straight replacement. ob_size is 0, so there is no outer
  // ring.
  vec2 edge=min(uv_orig,1.-uv_orig);
  ret=mix(ret,vec3(ibR,ibG,ibB),step(min(edge.x,edge.y),${glsl(BORDER_BAND)}));`,
    },
    {
      name: 'screen',
      output: 'screen',
      glsl: `
  // ZOOM-THROUGH: every feedback read below goes through uvz, which contracts
  // toward the frame centre as q30 rises, so the camera dives into the frame
  // mid-transition and settles exactly when the window ends. Display path only:
  // a zoom in the liquid pass would compound through the feedback and break the
  // seek reconstruction.
  vec2 uvz=((uv-.5)*(1.-q30*.15))+.5;

  // --- Sherwin's comp body ----------------------------------------------
  // The frame's own gradient bends two specular fields, so ridges in the
  // material catch light.
  vec2 sx=vec2(texsize.z,0.);
  vec2 sy=vec2(0.,texsize.w);
  vec2 g=vec2(
    texture(sampler_liquid,uvz-sx).x-texture(sampler_liquid,uvz+sx).x,
    texture(sampler_liquid,uvz-sy).x-texture(sampler_liquid,uvz+sy).x);
  vec2 f1=.3*cos((uvz-.5)*2.)-g;
  float spec1=clamp(.04/sqrt(dot(f1,f1)),0.,1.);
  vec2 f2=.3*cos(f1*12.)-9.*g;
  vec3 lit=spec1+texture(sampler_liquid,uvz).xyz*12.*clamp(.04/sqrt(dot(f2,f2)),0.,1.);

  // --- The journey grade -------------------------------------------------
  vec2 p=(uv-.5)*aspect.xy;
  vec3 tint=q21*tintA+q22*tintB+q23*tintC;
  float visibility=.72+.28*q24;
  float loudness=smoothstep(.01,.22,q26);
  vec3 material=max(lit-vec3(.065),vec3(0.));
  material=mix(material,vec3(dot(material,vec3(.299,.587,.114))),desat);
  float vignette=1.-.42*smoothstep(.28,.82,length(p));
  ret=(1.-exp(-material*tint*1.5*visibility))*vignette*loudness;

  // NOISE DISSOLVE: a threshold sweeping a slowly drifting noise field drops a
  // growing share of pixels as q30 peaks mid-transition. Dropped pixels
  // re-sample the frame at a noise-displaced position, so the outgoing look
  // shatters into scattered fragments of itself that settle into the incoming
  // tint. The feedback sample is normalized (x/(1+x)) before display; every
  // term stays bounded and nothing reaches the feedback.
  float grain=texture(sampler_noise_lq,uv*aspect.xy*5.+vec2(time*.00013,-time*.00009)).r;
  float grain2=texture(sampler_noise_lq,uv*aspect.xy*5.+vec2(-time*.00011,time*.00007)).g;
  float dropped=step(grain+.001,q30*.5);
  vec2 duv=(vec2(grain,grain2)-.5)*.3*q30;
  vec3 fragment=max(texture(sampler_liquid,uvz+duv).xyz,vec3(0.))*3.;
  fragment=fragment/(1.+fragment);
  fragment=mix(fragment,vec3(dot(fragment,vec3(.299,.587,.114))),desat);
  vec3 dust=(1.-exp(-fragment*tint*2.6*visibility))+vec3(spec1*grain)*tint*.9;
  ret=mix(ret,dust*vignette*loudness,dropped);`,
    },
  ],
}
