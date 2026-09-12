// Bright pass: what is left of the frame above the bloom threshold, at half
// resolution. The knee is a soft ramp either side of the threshold, so a note
// rising into bloom fades in instead of snapping on.

@group(0) @binding(0) var<uniform> post: PostParams;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var source: texture_2d<f32>;

@fragment
fn fs(in: Blit) -> @location(0) vec4<f32> {
  let colour = textureSample(source, samp, in.uv).rgb;
  let luma = dot(colour, vec3<f32>(0.2126, 0.7152, 0.0722));
  let threshold = post.bloom.x;
  let knee = post.bloom.y;
  let soft = clamp(luma - threshold + knee, 0.0, 2.0 * knee);
  let curve = soft * soft / (4.0 * knee);
  let keep = max(curve, luma - threshold) / max(luma, 0.0001);
  return vec4<f32>(colour * clamp(keep, 0.0, 1.0), 1.0);
}
