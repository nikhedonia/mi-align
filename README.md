# mi-align

Affine image alignment in the browser. Load two images (any size, any aspect ratio), and a WebGPU
compute kernel scores tens of thousands of candidate transforms in one pass. The result is not just
the best transform but a map of the whole similarity landscape: global optimum, competing local
optima, and the ridges in between.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build
npm run preview    # serve the production build
npm test           # browser test suites (headless Chrome + SwiftShader WebGPU)
```

Requires a WebGPU-capable browser (Chrome/Edge 113+). The app degrades to a clear error message if
WebGPU cannot start.

## What it does

**Field guide** — a built-in explainer at `#guide` covers the affine search space, the NCC
objective, joint mutual information and the 32×32 joint histogram, the WGSL workgroup kernel, the
N-D max-projection heatmap, and a tour of the studio. It is linked from the landing page and the
studio topbar, and can be opened directly with `/#guide`.

**Landing page** — start a new project (drop your own two images) or open one of five generated
examples. Every example ships with an exact ground truth transform, so the error is shown live.

**Exhaustive search** — the search space is the affine group with a per-axis grid:

| axis     | meaning                                     |
| -------- | ------------------------------------------- |
| `tx,ty`  | translation in normalised image units       |
| `θ`      | rotation                                    |
| `s`      | uniform scale                               |
| `a`      | aspect (sx/sy)                              |
| `sh`     | shear                                       |

The number of candidates is the product of the enabled axes' step counts. Candidates are scored
against image B with either a zero-mean NCC over a fixed set of sampled source pixels, minus an
overlap penalty, or an entropy-based mutual-information objective (`NMI − penalty`). One workgroup per
candidate, 128 invocations striding over the samples, tree-reduced in shared memory. Batches of 8192
candidates stream through the GPU with a progress bar. NCC is cheaper; MI can be more effective for
monotonic intensity changes and different imaging modalities, but each candidate needs its own 32×32
joint histogram, so it costs more.

**Stochastic multi-start** — optionally, draw `N` random candidates, keep the `K` best that are far
apart, then run a batched compass search from every seed (all seeds probe all axes in a single
dispatch). Trajectories are drawn on the heatmap.

**Sampling** — the cost is `candidates × samples`. Sampling can be a stratified jittered grid, uniform
random, or gradient-weighted (edges only). Turning sampling off uses every pixel (capped).

**The N-D heatmap** — the hard part: a 6-dimensional landscape cannot be drawn at once. The map shows
two axes of your choice and, for every cell, the **maximum over all remaining axes** (a max-projection
of the landscape). Isolated peaks are therefore genuine local optima of the full space. Hovering a
cell resolves the hidden axes' values and previews that exact transform in the overlay. `slice at best`
shows the true 2-D cross-section instead.

**Exploration** — the heatmap is a free camera over the parameter space: pan anywhere, zoom from 0.2× to
4096×, with no clamping to where data happens to be. The grid (cells, ticks, hit testing) follows the
pointer and the wheel instantly; the *search* catches up afterwards.

Every completed search is kept as a layer of a detail pyramid, positioned in root-grid coordinates.
When navigation settles for ~340 ms, the app checks the window: if fewer than ~25 cells of the finest
layer are on screen, or that layer covers less than ~55 % of the viewport, the visible window is
re-searched with the same step count. The base config for that search is the deepest layer covering the
window's centre (falling back to the root, whose parameter range then extrapolates — the space is not
artificially bounded).

So zooming in gives ~4× finer cells per level and panning to a neighbour yields its own search, while
the older, coarser layers stay visible around/behind the refined region (dimmed, with a thin blue
outline). Hit testing resolves against the finest layer under the pointer, so that surrounding context
is just as clickable as the refined patch. Unexplored cells inside a finer layer are transparent, so nothing ever turns black just
because you zoomed out — black only means "no computation covers this yet", and it fills in a moment
later. The palette itself is computed from the cells actually on screen and shared by every layer, so
a refined patch stays directly comparable with its coarser surroundings; the legend says
*shared across levels*.

`auto-refine with zoom` toggles the catch-up behaviour. Click a cell to select it and *dive inside* to
re-search just that cell (hidden axes are frozen at the value that produced it); `← up` walks back down
the stack. Explored cells get a dashed border.

**Locking** — any axis can be locked at a concrete value (⎘ copies the current value) and excluded
from the search, which is how you slice through the space and hunt for optima around a fixed rotation
or scale.

**Manual editing** — drag the moving image to translate, `shift`+drag sideways to rotate, `ctrl`+drag
radially to scale, `ctrl`+wheel to zoom out. Everything downstream (score, mutual information, joint
histogram) updates live, so you can feel how sharp the optimum is.

**Mutual information** — a separate single-transform kernel builds a 32×32 joint intensity histogram
in workgroup memory and reports MI in bits, normalised MI, both entropies, NCC and overlap. MI is
insensitive to monotonic brightness changes, so it is the honest multimodal readout; the joint
histogram is drawn next to it and tightens into a diagonal as the images line up. The same histogram
can drive the search itself: set the objective to `MI (NMI)` in the search panel. That
entropy-based path is more expensive than NCC because it clears and updates 1,024 bins for every
candidate. NCC is cheaper, but may be less effective when the intensity relationship is not linear or
the images are multimodal. MI is especially useful for multimodal pairs where feature-based matching
has no reliable correspondences — for example a visible-light image against an X-ray or XRF element
map. See [Villafañe et al., Proc. SPIE 12620, 1262004
(2023)](https://doi.org/10.1117/12.2673427) for a worked example registering MA-XRF element maps of
paintings to visible images.

**Overlay modes** — blend, absolute difference, checkerboard, A only, B only.

## Layout

```
src/
  lib/
    config.ts       search-space model (DOFs, grids, locking, cell ranges)
    affine.ts       6-DOF parameterisation <-> matrix, inverse, error metrics
    search.ts       exhaustive grid, stochastic multi-start, compass search
    heatmap.ts      max-projection / slice, argmax retention, local-maxima detection
    sampling.ts     source-pixel sampling strategies
    examples.ts     procedural scenes, two-viewpoint rendering, exact ground truth
    image.ts        file loading + canvas plumbing
  gpu/
    evalShader.ts   WGSL: per-candidate NCC/MI scorers + single-transform MI measurement
    aligner.ts      pipelines, buffers, chunked streams, readback
    warp.ts         render pipeline for the warped overlay
  components/       landing, panels, heatmap canvas, warp canvas, MI panel
    InfoPage.tsx    long-form explainer page (#guide)
  analytics.ts      optional GA4 event wrapper (VITE_GA_MEASUREMENT_ID)
  App.tsx           state machine: frames (dive stack), runs, manual edits
test/smoke.ts       end-to-end GPU test page (real kernels, real images)
scripts/            headless-Chrome drivers for the test suites
```

### Transform convention

Both images are mapped into a canonical frame: `X = (px + 0.5 − W/2) / R` with `R = max(W, H) / 2`.
Canonical coordinates therefore always span ±1 on the longer side, and the transform

```
X_b = M · X_a + t,      M = R(θ) · Shear(sh) · Scale(sx, sy)
```

is resolution- and aspect-independent. That is what lets a 640×480 detail be aligned to a 420×560
overview — the truth for that pair is `scale 0.64`, `θ 3°`, `t = (−0.068, 0.041)`.

Examples are generated by painting one large scene and "photographing" it from two viewpoints
(different windows, zooms, sensor rotation, anisotropic stretch and shear). The ground truth is
derived analytically from the two view matrices, then verified in the test suite by evaluating it.

## Deployment

The production site is built for:

```text
https://nikhedonia.net/mi-align/
```

`.github/workflows/deploy.yml` runs on every push to `main` or `master` (and manually via
**Run workflow**):

1. installs with `npm ci`,
2. typechecks and builds the production bundle with Vite base `/mi-align/`,
3. uploads `dist/` (including `.nojekyll`) as a GitHub Pages artifact,
4. deploys through the `github-pages` environment.

To enable it in the repository, open **Settings → Pages** and set the source to **GitHub Actions**.

This repository is named `mi-align`, so the GitHub Pages project path `/mi-align/` matches the
`VITE_BASE` in the workflow. If the repository is renamed, update `VITE_BASE` to the new name.

The `/mi-align/` path assumes that `nikhedonia.net` is configured as the custom domain on the
**user/organization Pages site** (`nikhedonia.github.io`). Project sites inherit the custom domain
and are served under `/<repository>/`. This repository therefore does **not** include a `CNAME` file:
adding one to a project site would make GitHub Pages serve that project at the domain root instead of
`/mi-align/`.

To reproduce the deployed asset paths locally:

```bash
VITE_BASE=/mi-align/ npm run build
VITE_BASE=/mi-align/ npm run preview
```

The dev server and plain `npm run build` use `/`.

## Analytics

GA4 is wired through `src/analytics.ts`, mirroring the paraplot setup. The deploy workflow exposes the
repository secret **`GA_MEASUREMENT_ID`** as `VITE_GA_MEASUREMENT_ID` at build time; when it is absent
analytics is disabled and no gtag script is loaded. Vite inlines `VITE_*` values into the bundle — a
measurement ID is a public identifier; the secret only keeps it out of git.

After adding the secret, re-run the workflow (Actions → “Deploy to GitHub Pages” → Run workflow) so
the deployed bundle is rebuilt with it.

Tracked events:

- `page_view` — landing / studio / field guide (sanitised paths)
- `guide_open`
- `example_open` (`example` id), `new_project`, `resume_session`
- `image_load` (`slot`: a|b), `image_swap`
- `search_run`, `search_complete` (`strategy`, `dofs`, `candidates`, `samples`, `best_score`)
- `heatmap_dive`, `heatmap_subdivide`, `heatmap_axis`, `heatmap_mode`
- `objective_change` (`ncc` | `mi`)
- `auto_refine_toggle`, `optimum_pick`, `polish`
- `webgpu_unavailable`, `search_error`

No image data, file names, project names, transforms or sample values are sent. GA sets analytics
cookies; add a consent flow if your jurisdiction requires one.

Local testing: `VITE_GA_MEASUREMENT_ID=G-XXXXXXX npm run dev`.

## Tests

`npm test` starts a dev server and drives headless Chrome (with SwiftShader when no GPU is present):

- `test/smoke.ts` — GPU pipeline end to end: scores the true transform vs decoys, runs a full grid +
  refinement (recovers the truth to ~0.06% of the image radius), checks the heatmap projection,
  optima detection, slice mode, stochastic search, the MI readout and MI search objective (higher at
  the truth, histogram sums to the sample count, entropy bounds), the renderer pixels, and evaluates
  the ground truth of every example.
- `scripts/ui-check.mjs` — landing page, opening the differing-size example, the suggested search
  space, live MI, drag/rotate/scale/zoom interactions, free heatmap pan/zoom with view-following
  re-search (coverage + readable cell size after settling), select/dive/back, shared palette,
  axis locking, and session resume.
- `scripts/visual-check.mjs` — captures screenshots and asserts on region statistics: the overlay
  shows content, the heatmap has peaks and black unexplored cells, the joint histogram is drawn.
