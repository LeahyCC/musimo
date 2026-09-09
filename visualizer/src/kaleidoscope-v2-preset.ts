import type { Preset } from './effects-presets.ts'
import { bake, dither, hueMatrix, kaleidoscopeTints, study } from './effects-presets.ts'
import type { StudioOptions } from './studio-options.ts'
import { desaturate, glsl, vec3 } from './studio-options.ts'

// Kaleidoscope V2. Built from two techniques found in the MilkDrop preset
// library rather than from a plain mirror:
//
// 1. Fractal feedback (Flexi's "fractal descent", "intensive shader fractal").
//    The feedback texture is the union of the last frame read through an
//    eight-fold mirror plus two shrunken copies of the whole frame placed
//    inside the wedge. Every copy carries its own copies, so detail nests at
//    every scale until the pixels run out. An unsharp mask against the blur
//    texture (Geiss' kaleidoscope) keeps that detail crisp across generations
//    and a per-frame hue rotation colours each generation differently.
//
// 2. Log-polar tunnel (Flexi's kaleidoscope in "Cope - Passage (mandala
//    mix)"). The display path maps the screen through a Möbius transform, then
//    into log-polar space, then mirrors it with a triangle wave in both axes,
//    and nests that mapping twice. In log-polar space a zoom is a translation,
//    so advancing one offset dives forever and reversing it climbs back out,
//    with no seam. The Möbius map has two singular points, a zero and a pole,
//    and both become tunnel centres: the vanishing point is never alone, and
//    as the two drift the tunnel forks into other voids.
//
// Determinism: no rand_frame or rand_preset. The per-frame equations keep
// smoothed audio accumulators (travel, spin, hit envelope), which is the same
// class of memory as the feedback and settles within the seek rebuild window.
export function createKaleidoscopeV2Preset(options: StudioOptions = {}): Preset {
  const b = bake(options)
  const [tintA, tintB] = kaleidoscopeTints[b.theme]
  const decay = glsl(Math.min(0.9995, 1 - 0.015 * b.gap))
  const hue = hueMatrix(0.009)
  const folds = '8.'
  const S = b.jsSpeed
  const P = b.jsPhase
  return study(
    {
      init: 'a.vb=0;a.vm=0;a.vt=0;a.mt=0;a.sp=0;a.pulse=0;',
      // Smoothed band energies drive travel and spin; a hit envelope drives
      // the pushes. Travel mostly dives, with a periodic pull back out.
      frame:
        'a.vb=.85*a.vb+.15*Math.min(a.bass*a.bass*.5,4);' +
        'a.vm=.85*a.vm+.15*Math.min(a.mid*a.mid*.5,4);' +
        'a.vt=.85*a.vt+.15*Math.min(a.treb*a.treb*.5,4);' +
        `a.mt+=(.002+.005*a.vb)*${S}*(.35+Math.sin(.07*a.time*${S}+${P}));` +
        `a.sp+=(.0006+.0015*a.vt)*${S};` +
        `a.pulse=Math.max(a.pulse*.92,Math.min(1,(a.bass-a.bass_att)*2*${b.sensitivity}));` +
        'a.q1=a.mt;a.q2=a.sp;a.q3=a.pulse;a.q4=a.vb;a.q5=a.vm;' +
        'a.zoom=1;a.rot=0;a.warp=0;a.wave_a=0;',
      pixel: '',
    },
    `
      float t=time*${b.speed};
      vec2 p=(uv-.5)*aspect.xy;
      float r=length(p);
      float an=atan(p.y,p.x);
      ${dither('t')}
      // Eight-fold mirror into one wedge, turning with the spin accumulator.
      float seg=6.28318/${folds};
      float fa=abs(mod(an-q2,seg)-seg*.5);
      vec2 w=r*vec2(cos(fa),sin(fa));
      // Self: the last frame at the mirrored point, breathing in and out,
      // pushed inward on hits.
      float zs=1.+.006*sin(t*.13+${b.phase})+.012*q3;
      vec2 rw=vec2(w.x*cos(q2)-w.y*sin(q2),w.x*sin(q2)+w.y*cos(q2));
      vec2 ks=.5+rw*zs/aspect.xy;
      vec3 self=texture(sampler_main,ks).xyz;
      // Copies: the whole frame shrunk into two satellites inside the wedge.
      // The mirror multiplies them around the ring; each carries its own.
      vec2 k1=.5+((w-vec2(.30,.06))*2.4)/aspect.xy;
      vec2 k2=.5+((w-vec2(.17,.14))*3.2)/aspect.xy;
      float in1=step(0.,k1.x)*step(k1.x,1.)*step(0.,k1.y)*step(k1.y,1.);
      float in2=step(0.,k2.x)*step(k2.x,1.)*step(0.,k2.y)*step(k2.y,1.);
      vec3 copies=max(texture(sampler_main,k1).xyz*in1,texture(sampler_main,k2).xyz*in2);
      vec3 c=max(self,copies*.92);
      // Unsharp mask keeps nested detail crisp across generations.
      vec3 soft=texture(sampler_blur2,ks).xyz*scale2+bias2;
      c=min(max(c+(c-soft)*.1,vec3(0.)),vec3(4.));
      c=${hue}*c;
      c=max(c*${decay}-vec3(.0008+dither*.0015),vec3(0.));
      // Sources in wedge coordinates: a seed ring that flares on hits and a
      // textured cell near a satellite, so the fractal always has material.
      vec3 col=.5+.5*vec3(sin(t*.37+${b.phase}),sin(t*.37+${b.phase}+2.09),sin(t*.37+${b.phase}+4.19));
      float ring=smoothstep(.02,0.,abs(r-.1-.03*sin(t*.5)))*(.25+.75*q3);
      float cell=smoothstep(.06,0.,length(w-vec2(.24,.05)))*texture(sampler_noise_lq,w*4.+t*.03).r;
      ret=c+col*(ring*.012+cell*.008)+vec3(.0006);
    `,
    `
      float t=time*${b.speed};
      // The two voids: a Möbius zero at -A and a pole at -B, both drifting.
      vec2 A=vec2(1.+.35*sin(t*.023+${b.phase}),.3*cos(t*.031+${b.phase}));
      vec2 B=vec2(-1.+.3*cos(t*.019+${b.phase}*1.3),.35*sin(t*.027+${b.phase}));
      vec2 z=(uv-.5)*2.*aspect.wz;
      vec2 n=z+A;
      vec2 d=z+B;
      vec2 m=vec2(n.x*d.x+n.y*d.y,n.y*d.x-n.x*d.y)/max(dot(d,d),1e-6);
      // Log-polar: angle across, log radius down. Travel q1 is the dive.
      vec2 lp=vec2(atan(m.y,m.x)*.3183+q2*.3,.3*log(length(m)+1e-6)-q1);
      vec2 f=vec2(lp.x*${folds}*.5,lp.y);
      vec2 u1=.5+(.5-abs(fract(f*.5)*2.-1.))*.95;
      // Nest the same mapping once more for self-similar depth.
      vec2 z2=(u1-.5)*2.*aspect.wz;
      n=z2+A;
      d=z2+B;
      m=vec2(n.x*d.x+n.y*d.y,n.y*d.x-n.x*d.y)/max(dot(d,d),1e-6);
      lp=vec2(atan(m.y,m.x)*.3183+q2*.3,.3*log(length(m)+1e-6)-q1);
      f=vec2(lp.x*${folds}*.5,lp.y);
      vec2 u2=.5+(.5-abs(fract(f*.5)*2.-1.))*.95;
      float tide=.55+.35*sin(t*.05+${b.phase});
      vec3 fabric=mix(texture(sampler_main,u1).xyz,texture(sampler_main,u2).xyz,tide)
              +texture(sampler_main,vec2(1.-u2.x,u2.y)).xyz*.35;
      // Crispness: unsharp against the blur at the remapped point.
      vec3 bl=texture(sampler_blur1,u2).xyz*scale1+bias1;
      fabric=max(fabric+(fabric-bl)*.5,vec3(0.));
      // Relief lighting at the remapped point.
      vec2 g=vec2(
        texture(sampler_main,u2-vec2(texsize.z,0.)).x-texture(sampler_main,u2+vec2(texsize.z,0.)).x,
        texture(sampler_main,u2-vec2(0.,texsize.w)).x-texture(sampler_main,u2+vec2(0.,texsize.w)).x);
      vec2 f1=.3*cos((u2-.5)*2.)-g;
      float spec1=clamp(.04/length(f1),0.,1.);
      vec2 f2=.3*cos(f1*12.)-9.*g;
      float spec2=clamp(.04/length(f2),0.,1.);
      vec3 material=max(spec1*.5+fabric*4.*spec2+fabric*.6-vec3(.05),vec3(0.));
      ${desaturate(b.theme, 'material')}
      vec2 pv=(uv-.5)*aspect.xy;
      vec3 tint=mix(${vec3(tintA)},${vec3(tintB)},.5+.5*sin(t*.03+atan(pv.y,pv.x)+${b.phase}));
      float veins=1.-.5*smoothstep(.03,.2,length(g)*4.);
      vec3 colour=1.-exp(-material*tint*2.2);
      float vignette=1.-.35*smoothstep(.3,.9,length(pv));
      ret=colour*colour*vignette*veins;
    `,
    { zoom: 1, warp: 0, wrap: 0, warpscale: 0.1 },
  )
}
