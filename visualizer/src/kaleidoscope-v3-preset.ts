import type { Preset } from './effects-presets.ts'
import { bake, kaleidoscopeTints, relief, study } from './effects-presets.ts'
import type { StudioOptions } from './studio-options.ts'
import { desaturate, glsl, vec3 } from './studio-options.ts'

// Kaleidoscope V3: a directly evaluated fractal, not a feedback effect.
//
// Butterchurn's feedback is 8-bit, so a fractal grown in the loop blurs and
// quantises every generation. V3 never grows anything: each frame computes a
// kaleidoscopic IFS per pixel (fold, scale, offset, repeat) and colours it
// from orbit traps, the way fractal-flame and KIFS renders are made. The
// 8-bit loop only ever holds a finished image for a little motion
// persistence, and the free blur passes give glow in the display pass.
//
// The screen reaches the fractal through the log-polar tunnel from V2: a
// Möbius map with two drifting singular points (two tunnel centres), then
// log-polar so travel is a slide and the dive is endless in both directions.
//
// Determinism: pure function of media time, band levels and the per-frame
// accumulators (travel, spin, hit envelope), which settle inside the seek
// rebuild. No rand_frame or rand_preset.
export function createKaleidoscopeV3Preset(options: StudioOptions = {}): Preset {
  const b = bake(options)
  const [tintA, tintB] = kaleidoscopeTints[b.theme]
  // Motion persistence in the 8-bit loop: trails right keeps more of the last frame.
  const persist = glsl(Math.min(0.5, Math.max(0.02, 0.15 * (2 - b.gap))))
  const S = b.jsSpeed
  const P = b.jsPhase
  return study(
    {
      init: 'a.vb=0;a.vm=0;a.vt=0;a.mt=0;a.sp=0;a.pulse=0;',
      // Smoothed bands: bass blooms the figure and drives travel, treble
      // spins, mids drift the fold angle. Travel mostly dives, with a slow
      // periodic climb back out.
      frame:
        'a.vb=.85*a.vb+.15*Math.min(a.bass*a.bass*.5,4);' +
        'a.vm=.85*a.vm+.15*Math.min(a.mid*a.mid*.5,4);' +
        'a.vt=.85*a.vt+.15*Math.min(a.treb*a.treb*.5,4);' +
        `a.mt+=(.0015+.004*a.vb)*${S}*(.35+Math.sin(.06*a.time*${S}+${P}));` +
        `a.sp+=(.0005+.0012*a.vt)*${S};` +
        `a.pulse=Math.max(a.pulse*.9,Math.min(1,(a.bass-a.bass_att)*2*${b.sensitivity}));` +
        'a.q1=a.mt;a.q2=a.sp;a.q3=a.pulse;a.q4=a.vb;a.q5=a.vm;' +
        'a.zoom=1;a.rot=0;a.warp=0;a.wave_a=0;',
      pixel: '',
    },
    `
      float t=time*${b.speed};
      // Tunnel: Möbius zero at -A and pole at -B, both drifting, then log-polar.
      vec2 A=vec2(1.+.35*sin(t*.023+${b.phase}),.3*cos(t*.031+${b.phase}));
      vec2 B=vec2(-1.+.3*cos(t*.019+${b.phase}*1.3),.35*sin(t*.027+${b.phase}));
      vec2 z=(uv_orig-.5)*2.*aspect.wz;
      vec2 n=z+A;
      vec2 d=z+B;
      vec2 m=vec2(n.x*d.x+n.y*d.y,n.y*d.x-n.x*d.y)/max(dot(d,d),1e-6);
      vec2 lp=vec2(atan(m.y,m.x)*.3183+q2*.3,.3*log(length(m)+1e-6)-q1);
      // Eight mirrored wedges across, mirrored depth down: a tile in [-1,1]².
      vec2 c=abs(fract(vec2(lp.x*4.,lp.y)*.5)*2.-1.)*2.-1.;
      // Kaleidoscopic IFS. Bass swells the scale, mids turn the fold, the
      // spin accumulator rotates each generation a little.
      float sc=1.9+.25*sin(t*.11+${b.phase})+.15*clamp(q4,0.,1.5);
      vec2 off=vec2(1.,.55)+vec2(.2*sin(t*.07+${b.phase}),.2*cos(t*.05+${b.phase}));
      float th=.6+.3*sin(t*.043+${b.phase})+.1*clamp(q5,0.,1.5);
      mat2 R=mat2(cos(th),sin(th),-sin(th),cos(th));
      mat2 Ri=mat2(cos(th),-sin(th),sin(th),cos(th));
      float sp=q2*.15;
      mat2 Rs=mat2(cos(sp),sin(sp),-sin(sp),cos(sp));
      vec2 trapPt=vec2(.6*cos(t*.09+${b.phase}),.5*sin(t*.13+${b.phase}));
      float trapR=1e9;
      float trapX=1e9;
      float trapP=1e9;
      float hit=0.;
      for(int i=0;i<12;i++){
        c=abs(c);
        c=Ri*abs(R*c);
        c=c*sc-off*(sc-1.);
        c=Rs*c;
        float dr=length(c);
        if(dr<trapR){trapR=dr;hit=float(i);}
        trapX=min(trapX,abs(c.x));
        trapP=min(trapP,length(c-trapPt));
      }
      // Colour from the traps: rainbow contour bands over the trap distance,
      // a per-generation palette on the closest layer, bright ridges, dark
      // leading between cells, and a flash at the moving trap point on hits.
      vec3 pal=.5+.5*cos(6.28318*(trapR*1.5+vec3(0.,.33,.67))+t*.1+${b.phase});
      vec3 layer=.5+.5*cos(6.28318*(hit/12.)*vec3(1.,.9,.8)+vec3(0.,2.,4.)+${b.phase});
      float skel=exp(-trapR*3.);
      float ridge=smoothstep(.35,0.,trapX);
      float flash=exp(-trapP*2.5)*(.3+.7*q3);
      vec3 col=pal*(.25+.75*skel)+layer*ridge*.5+vec3(1.,.9,.7)*flash*.5;
      col*=1.-.6*smoothstep(.04,0.,trapX);
      // The loop is 8-bit: store a finished image, lightly persisted.
      ret=mix(col*.6,texture(sampler_main,uv_orig).xyz,${persist});
    `,
    `
      float t=time*${b.speed};
      vec3 base=texture(sampler_main,uv).xyz;
      vec3 g1=texture(sampler_blur1,uv).xyz*scale1+bias1;
      vec3 g2=texture(sampler_blur2,uv).xyz*scale2+bias2;
      vec3 g3=texture(sampler_blur3,uv).xyz*scale3+bias3;
      vec3 glowc=g1*.25+g2*.35+g3*.4;
      ${relief}
      vec3 material=base*1.3+glowc*.8+base*spec2*3.+vec3(spec1*.15);
      ${desaturate(b.theme, 'material')}
      vec2 pv=(uv-.5)*aspect.xy;
      // Themes bias the palette rather than replace it; Mono still goes silver.
      vec3 tint=mix(vec3(1.),mix(${vec3(tintA)},${vec3(tintB)},.5+.5*sin(t*.03+atan(pv.y,pv.x)+${b.phase})),.35);
      float veins=1.-.4*smoothstep(.03,.2,length(g)*4.);
      vec3 colour=1.-exp(-material*tint*2.);
      float vignette=1.-.35*smoothstep(.3,.9,length(pv));
      ret=colour*colour*vignette*veins;
    `,
    { zoom: 1, warp: 0, wrap: 0, warpscale: 0.1 },
  )
}
