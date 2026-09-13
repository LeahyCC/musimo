// Shared declarations for the particle scene. Prepended to both shaders by
// Particles.ts, so the structs cannot drift between the compute and render
// halves. The Features struct is the packet from FeatureExtractor.ts.

struct Features {
  bands: vec4<f32>,   // sub, bass, lowMid, highMid
  levels: vec4<f32>,  // treble, energy, flux, fluxThreshold
  beat: vec4<f32>,    // onset, onsetStrength, beatPulse, tempo
  clock: vec4<f32>,   // time, dt, 0, 0
}

// The four tuning vectors arrive already modulated: the preset's resting
// value plus whatever its audio mapping added this frame, resolved on the CPU
// in particles.params.ts. Nothing below reads the packet for a magnitude.
struct Params {
  camera: mat4x4<f32>,
  resolution: vec2<f32>,
  count: u32,
  reset: u32,
  pointSize: f32,
  intensity: f32,
  pad: vec2<f32>,
  motion: vec4<f32>,  // flow, noiseFrequency, attract, push
  body: vec4<f32>,    // jitter, spring, drag, speedCap
  life: vec4<f32>,    // advance, respawn, orbitSpeed, orbitRadius
  look: vec4<f32>,    // warmth, brightness, speedLight, sizeBump
}

struct Particle {
  position: vec3<f32>,
  life: f32,
  velocity: vec3<f32>,
  seed: f32,
}

@group(0) @binding(0) var<uniform> features: Features;
@group(0) @binding(1) var<uniform> params: Params;
