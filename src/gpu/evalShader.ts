/**
 * Candidate scoring kernel.
 *
 * One workgroup == one candidate affine transform. The 128 invocations of the
 * workgroup stride over the sampled source pixels, transform them into image B,
 * bilinearly fetch B, and accumulate the five sums needed for a zero-mean
 * normalised cross-correlation (NCC). Those sums are tree-reduced in shared
 * memory and the final score is written by invocation 0.
 *
 *   out[i*8 + 0] = score   (NCC with overlap penalty; < -2 means rejected)
 *   out[i*8 + 1] = ncc     (raw correlation, -1..1)
 *   out[i*8 + 2] = overlap (fraction of samples landing inside B)
 *   out[i*8 + 3] = meanA
 *   out[i*8 + 4] = meanB
 */
export const EVAL_WGSL = /* wgsl */ `
struct Uniforms {
  count: u32,
  sampleCount: u32,
  _p0: u32,
  _p1: u32,
  imgBWidth: f32,
  imgBHeight: f32,
  rB: f32,
  minValid: f32,
  overlapPenalty: f32,
  _p2: f32,
  _p3: f32,
  _p4: f32,
};

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var texB: texture_2d<f32>;
@group(0) @binding(2) var sampB: sampler;
@group(0) @binding(3) var<storage, read> candidates: array<f32>;
@group(0) @binding(4) var<storage, read> samplePos: array<vec2f>;
@group(0) @binding(5) var<storage, read> sampleLuma: array<f32>;
@group(0) @binding(6) var<storage, read_write> outv: array<f32>;

const WG: u32 = 128u;

var<workgroup> s_sa: array<f32, 128>;
var<workgroup> s_sb: array<f32, 128>;
var<workgroup> s_sab: array<f32, 128>;
var<workgroup> s_saa: array<f32, 128>;
var<workgroup> s_sbb: array<f32, 128>;
var<workgroup> s_cnt: array<f32, 128>;

@compute @workgroup_size(128)
fn main(
  @builtin(workgroup_id) wid: vec3u,
  @builtin(local_invocation_index) lid: u32,
) {
  let ci = wid.x;
  // ci is workgroup-uniform, so this branch is uniform (no barrier divergence)
  let isActive = ci < U.count;

  let b = ci * 8u;
  let m0 = candidates[b + 0u];
  let m1 = candidates[b + 1u];
  let m2 = candidates[b + 2u];
  let m3 = candidates[b + 3u];
  let tx = candidates[b + 4u];
  let ty = candidates[b + 5u];

  var sa = 0.0;
  var sb = 0.0;
  var sab = 0.0;
  var saa = 0.0;
  var sbb = 0.0;
  var cnt = 0.0;

  if (isActive) {
    let kx = U.rB / U.imgBWidth;
    let ky = U.rB / U.imgBHeight;
    for (var i = lid; i < U.sampleCount; i = i + WG) {
      let p = samplePos[i];
      let xb = m0 * p.x + m1 * p.y + tx;
      let yb = m2 * p.x + m3 * p.y + ty;
      let u = 0.5 + xb * kx;
      let v = 0.5 + yb * ky;
      if (u >= 0.0 && u <= 1.0 && v >= 0.0 && v <= 1.0) {
        let c = textureSampleLevel(texB, sampB, vec2f(u, v), 0.0);
        let lb = dot(c.rgb, vec3f(0.299, 0.587, 0.114));
        let la = sampleLuma[i];
        sa = sa + la;
        sb = sb + lb;
        sab = sab + la * lb;
        saa = saa + la * la;
        sbb = sbb + lb * lb;
        cnt = cnt + 1.0;
      }
    }
  }

  s_sa[lid] = sa;
  s_sb[lid] = sb;
  s_sab[lid] = sab;
  s_saa[lid] = saa;
  s_sbb[lid] = sbb;
  s_cnt[lid] = cnt;
  workgroupBarrier();

  var stride = WG / 2u;
  loop {
    if (stride == 0u) { break; }
    if (lid < stride) {
      s_sa[lid] = s_sa[lid] + s_sa[lid + stride];
      s_sb[lid] = s_sb[lid] + s_sb[lid + stride];
      s_sab[lid] = s_sab[lid] + s_sab[lid + stride];
      s_saa[lid] = s_saa[lid] + s_saa[lid + stride];
      s_sbb[lid] = s_sbb[lid] + s_sbb[lid + stride];
      s_cnt[lid] = s_cnt[lid] + s_cnt[lid + stride];
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  if (lid == 0u) {
    let n = s_cnt[0];
    var score = -3.0;
    var ncc = 0.0;
    var overlap = 0.0;
    var meanA = 0.0;
    var meanB = 0.0;

    if (n >= 8.0) {
      overlap = n / f32(U.sampleCount);
      meanA = s_sa[0] / n;
      meanB = s_sb[0] / n;
      let va = max(s_saa[0] - s_sa[0] * s_sa[0] / n, 0.0);
      let vb = max(s_sbb[0] - s_sb[0] * s_sb[0] / n, 0.0);
      let cov = s_sab[0] - s_sa[0] * s_sb[0] / n;
      let den = sqrt(va * vb);
      if (den > 1e-7) {
        ncc = cov / den;
      }
      score = ncc - U.overlapPenalty * (1.0 - overlap);
      if (overlap < U.minValid) {
        score = -2.0 - (U.minValid - overlap) * 4.0;
      }
    }

    let o = ci * 8u;
    outv[o + 0u] = score;
    outv[o + 1u] = ncc;
    outv[o + 2u] = overlap;
    outv[o + 3u] = meanA;
    outv[o + 4u] = meanB;
    outv[o + 5u] = 0.0;
    outv[o + 6u] = 0.0;
    outv[o + 7u] = 0.0;
  }
}
`;

export const UNIFORM_FLOATS = 12;
