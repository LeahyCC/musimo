// The previous frame, zoomed and rotated a little about the middle, decayed,
// and added under the scene. The scene has already drawn into this pass's
// target, so the pass is additively blended rather than reading it back.

@group(0) @binding(0) var<uniform> post: PostParams;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var history: texture_2d<f32>;

@fragment
fn fs(in: Blit) -> @location(0) vec4<f32> {
  let zoom = max(post.feedback.z, 0.001);
  let angle = post.feedback.w;
  // Work in square coordinates so a rotation does not shear a wide stage.
  let aspect = vec2<f32>(post.resolution.x / max(post.resolution.y, 1.0), 1.0);
  let centred = (in.uv - vec2<f32>(0.5)) * aspect;
  let s = sin(angle);
  let c = cos(angle);
  let turned = vec2<f32>(centred.x * c - centred.y * s, centred.x * s + centred.y * c) / zoom;
  let uv = clamp(turned / aspect + vec2<f32>(0.5), vec2<f32>(0.0), vec2<f32>(1.0));
  let old = textureSample(history, samp, uv).rgb * post.feedback.x * post.feedback.y;
  return vec4<f32>(old, 1.0);
}
