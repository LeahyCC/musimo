// One half of a separable Gaussian. Five taps at the offsets that land between
// texels, so the hardware's own filtering makes it a nine-tap blur for the
// price of five. The step's texel size is the source's, so the horizontal pass
// can read the level above and land in the smaller one.

struct BlurStep {
  texel: vec2<f32>,
  direction: vec2<f32>,
}

@group(0) @binding(0) var<uniform> blur: BlurStep;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var source: texture_2d<f32>;

@fragment
fn fs(in: Blit) -> @location(0) vec4<f32> {
  let offset = blur.texel * blur.direction;
  var sum = textureSample(source, samp, in.uv).rgb * 0.2270270270;
  let near = offset * 1.3846153846;
  let far = offset * 3.2307692308;
  sum += (textureSample(source, samp, in.uv + near).rgb +
          textureSample(source, samp, in.uv - near).rgb) * 0.3162162162;
  sum += (textureSample(source, samp, in.uv + far).rgb +
          textureSample(source, samp, in.uv - far).rgb) * 0.0702702703;
  return vec4<f32>(sum, 1.0);
}
