import sherwin from 'butterchurn-presets/presets/converted/Flexi, martin + geiss - dedicated to the sherwin maxawow.json'

// Retain Sherwin Maxawow's feedback and surface-lighting shaders, with continuous
// noise travel and slow vortices. All score states inhabit this same liquid.
// Original: Flexi, martin + geiss, butterchurn-presets 2.4.7, MIT.
// See THIRD_PARTY_NOTICES.md for the original authors and package notices.
export function createJourneyPreset() {
  const preset = structuredClone(sherwin)
  preset.baseVals.gammaadj = 1.5
  preset.baseVals.wave_a = 0.002
  preset.baseVals.darken = 0
  preset.frame_eqs_str =
    preset.frame_eqs_str.replaceAll('a.time', '(a.time*.075+a.q28*.8)') + 'a.q32=a.aspecty;'
  // Clock scaling only affects this preset's motion equations. The renderer and
  // controller still use exact media seconds, including through transitions.
  preset.pixel_eqs_str = preset.pixel_eqs_str
    .replaceAll('a.time', '(a.time*.075+a.q28*.8)')
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
      ret=max(tmpvar_4.xyz*.997,vec3(0.)) + vec3(light*light*.0009);
    `,
    )
  preset.comp = preset.comp.replace(
    'ret = tmpvar_6.xyz;',
    `
    vec2 p=(uv-.5)*aspect.xy;
    vec3 tint=q21*vec3(.63,.94,1.)+q22*vec3(.65,.76,1.)+q23*vec3(1.,.82,.59);
    float visibility=.72+.28*q24;
    float loudness=smoothstep(.01,.22,q26);
    vec3 material=max(tmpvar_6.xyz-vec3(.065),vec3(0.));
    float vignette=1.-.42*smoothstep(.28,.82,length(p));
    ret=(1.-exp(-material*tint*1.5*visibility))*vignette*loudness;
  `,
  )
  return preset
}
