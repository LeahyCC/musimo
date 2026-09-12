// Drawing the dye. One oversized triangle over the post stack's texture, the
// dye sampled through it and coloured from the palette lookup table, so the
// field reads as a gradient rather than one tint at different strengths.

@group(0) @binding(2) var dye: texture_2d<f32>;
@group(0) @binding(3) var palette: texture_2d<f32>;

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
  // Clip space is y up, texture coordinates are y down.
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}

@fragment
fn fs(in: Blit) -> @location(0) vec4<f32> {
  // The grid is square and the canvas is not. The grid covers the canvas and
  // the overflow is cropped, so the scale is the same on both axes and a
  // round splat stays round; `visibleExtent` places the emitters to match.
  let uv = (in.uv - vec2<f32>(0.5, 0.5)) * sim.cover.xy + vec2<f32>(0.5, 0.5);
  let sample = textureSample(dye, samp, uv);
  let density = max(sample.x, 0.0);
  let coord = atan2(sample.z, sample.y) / TAU + 0.5;
  let tint = textureSample(palette, samp, vec2<f32>(coord, 0.5)).rgb;
  // Dye stacks without limit where plumes cross. This bends it into 0 to 1,
  // so a thick one reads as its own colour instead of a flat white mass, and
  // the intensity above puts the brightest of it past the bloom threshold.
  let amount = 1.0 - exp(-density * 1.2);
  let base = vec3<f32>(0.008, 0.012, 0.02);
  return vec4<f32>(base + tint * amount * sim.mix.y, 1.0);
}
