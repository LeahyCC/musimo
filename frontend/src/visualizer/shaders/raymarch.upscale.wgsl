// Half-resolution upsample, used only on a software rasteriser. The march
// draws into a texture half the canvas each side and this stretches it back
// with the hardware filtering, which costs one bilinear tap a pixel against a
// march that would otherwise cost four times what it does.
//
// Standalone rather than sharing raymarch.common.wgsl: this pass never reads
// the march uniform, and a declared binding it does not use would not appear
// in the layout the pipeline derives.

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var source: texture_2d<f32>;

struct Blit {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> Blit {
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0),
  );
  let p = corners[vi];
  var out: Blit;
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}

@fragment
fn fs(in: Blit) -> @location(0) vec4<f32> {
  return vec4<f32>(textureSample(source, samp, in.uv).rgb, 1.0);
}
