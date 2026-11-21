import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { EXAMPLES, type Example } from '../lib/examples';
import './InfoPage.css';

interface InfoPageProps {
  onBack: () => void;
  onNew: () => void;
  onExample: (example: Example) => void;
}

function Formula({ children }: { children: ReactNode }) {
  return <div className="guide-formula">{children}</div>;
}

function Figure({ children, caption }: { children: ReactNode; caption: string }) {
  return (
    <figure className="guide-figure">
      {children}
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* diagrams                                                            */
/* ------------------------------------------------------------------ */

function Grid({
  cx,
  cy,
  size,
  cells,
  stroke,
  dash,
}: {
  cx: number;
  cy: number;
  size: number;
  cells: number;
  stroke: string;
  dash?: string;
}) {
  const half = size / 2;
  const step = size / cells;
  return (
    <g stroke={stroke} strokeWidth="1" strokeDasharray={dash} fill="none">
      {Array.from({ length: cells + 1 }, (_, i) => (
        <line key={`v${i}`} x1={cx - half + i * step} y1={cy - half} x2={cx - half + i * step} y2={cy + half} />
      ))}
      {Array.from({ length: cells + 1 }, (_, i) => (
        <line key={`h${i}`} x1={cx - half} y1={cy - half + i * step} x2={cx + half} y2={cy - half + i * step} />
      ))}
    </g>
  );
}

function TransformDiagram() {
  return (
    <svg className="guide-svg" viewBox="0 0 400 240" role="img" aria-labelledby="transform-diagram-title">
      <title id="transform-diagram-title">
        A square grid in image A is translated, rotated, scaled and sheared into image B.
      </title>
      <defs>
        <radialGradient id="transform-bg" cx="46%" cy="40%" r="76%">
          <stop offset="0%" stopColor="#141d30" />
          <stop offset="100%" stopColor="#06080e" />
        </radialGradient>
        <marker id="transform-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="#6ea8fe" />
        </marker>
      </defs>
      <rect width="400" height="240" rx="14" fill="url(#transform-bg)" />
      <Grid cx={78} cy={132} size={112} cells={7} stroke="rgba(110,168,254,0.32)" />
      <circle cx={78} cy={132} r={3} fill="#ffd166" />
      <text x={78} y={216} className="guide-svg-label" textAnchor="middle">
        image A
      </text>
      <text x={78} y={228} className="guide-svg-label guide-svg-label--muted" textAnchor="middle">
        canonical X
      </text>

      <line x1={150} y1={120} x2={196} y2={120} stroke="#6ea8fe" strokeWidth="1.4" markerEnd="url(#transform-arrow)" />
      <text x={173} y={110} className="guide-svg-label" textAnchor="middle">
        M, t
      </text>

      <g transform="translate(300 126) rotate(-9) skewX(-9) scale(1.06)">
        <Grid cx={0} cy={0} size={112} cells={7} stroke="rgba(255,209,102,0.38)" />
      </g>
      <circle cx={311} cy={114} r={3} fill="#ffd166" />
      <text x={306} y={216} className="guide-svg-label" textAnchor="middle">
        image B
      </text>
      <text x={306} y={228} className="guide-svg-label guide-svg-label--muted" textAnchor="middle">
        X_b = M · X_a + t
      </text>

      <g stroke="rgba(122,209,81,0.72)" strokeWidth="1.2" fill="none">
        <line x1={78} y1={132} x2={132} y2={132} />
        <line x1={78} y1={132} x2={78} y2={72} />
      </g>
      <text x={140} y={136} className="guide-svg-label guide-svg-label--muted">
        tx
      </text>
      <text x={68} y={64} className="guide-svg-label guide-svg-label--muted" textAnchor="end">
        ty
      </text>
      <text x={214} y={158} className="guide-svg-label guide-svg-label--muted">
        θ · s · a · sh
      </text>
    </svg>
  );
}

const HIST = 10;

function histCell(row: number, col: number, spread: number, ripple: number): number {
  const d = row - col;
  const band = Math.exp(-(d * d) / (2 * spread * spread));
  const texture = 0.7 + 0.3 * Math.cos((row * 1.7 + col * 2.3) * ripple);
  return Math.min(1, band * texture);
}

function JointHistogram({
  x,
  y,
  spread,
  color,
  label,
  value,
}: {
  x: number;
  y: number;
  spread: number;
  color: string;
  label: string;
  value: string;
}) {
  const size = 98;
  const cell = size / HIST;
  return (
    <g>
      <rect x={x - 5} y={y - 5} width={size + 10} height={size + 10} rx={8} fill="#080b12" stroke="rgba(120,140,170,0.22)" />
      {Array.from({ length: HIST * HIST }, (_, i) => {
        const row = Math.floor(i / HIST);
        const col = i % HIST;
        const v = histCell(row, col, spread, 0.35);
        return (
          <rect
            key={i}
            x={x + col * cell}
            y={y + row * cell}
            width={cell + 0.4}
            height={cell + 0.4}
            fill={`rgba(${color}, ${0.05 + v * 0.9})`}
          />
        );
      })}
      <line
        x1={x}
        y1={y + size}
        x2={x + size}
        y2={y}
        stroke="rgba(255,255,255,0.32)"
        strokeWidth="1"
        strokeDasharray="2 3"
      />
      <text x={x + size / 2} y={y + size + 16} className="guide-svg-label" textAnchor="middle">
        {label}
      </text>
      <text x={x + size / 2} y={y + size + 29} className="guide-svg-label guide-svg-label--muted" textAnchor="middle">
        {value}
      </text>
    </g>
  );
}

function HistogramDiagram() {
  return (
    <svg className="guide-svg" viewBox="0 0 400 240" role="img" aria-labelledby="histogram-diagram-title">
      <title id="histogram-diagram-title">
        Aligned images produce a tight diagonal joint histogram and high mutual information; misaligned images spread it out.
      </title>
      <rect width="400" height="240" rx="14" fill="#070a11" />
      <JointHistogram x={38} y={48} spread={0.75} color="110,168,254" label="aligned" value="I(A;B) high" />
      <JointHistogram x={248} y={48} spread={2.7} color="255,209,102" label="misaligned" value="I(A;B) low" />
      <line x1={196} y1={48} x2={196} y2={146} stroke="rgba(120,140,170,0.18)" strokeDasharray="3 5" />
      <text x={196} y={36} className="guide-svg-label guide-svg-label--muted" textAnchor="middle">
        joint histogram p(a,b)
      </text>
      <text x={196} y={206} className="guide-svg-label guide-svg-label--muted" textAnchor="middle">
        x: intensity in A · y: intensity in B · 32 × 32 bins
      </text>
      <text x={196} y={224} className="guide-svg-label guide-svg-label--muted" textAnchor="middle">
        MI compares the joint distribution with the product of the marginals
      </text>
    </svg>
  );
}

function ProjectionDiagram() {
  const hidden = [
    { label: 'θ', x: 44 },
    { label: 's', x: 80 },
    { label: 'a', x: 116 },
    { label: 'sh', x: 152 },
  ];
  const heat = [
    [0.18, 0.3, 0.45, 0.6, 0.45, 0.3],
    [0.26, 0.42, 0.7, 0.92, 0.66, 0.36],
    [0.3, 0.55, 0.86, 1, 0.78, 0.4],
    [0.24, 0.4, 0.62, 0.8, 0.58, 0.3],
    [0.16, 0.26, 0.4, 0.52, 0.38, 0.2],
    [0.1, 0.16, 0.25, 0.3, 0.22, 0.12],
  ];
  return (
    <svg className="guide-svg" viewBox="0 0 400 240" role="img" aria-labelledby="projection-diagram-title">
      <title id="projection-diagram-title">
        A six-dimensional score field is projected to two visible axes by taking the maximum over the hidden axes.
      </title>
      <rect width="400" height="240" rx="14" fill="#070a11" />
      <defs>
        <marker id="projection-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="#6ea8fe" />
        </marker>
      </defs>
      <text x={98} y={34} className="guide-svg-label guide-svg-label--muted" textAnchor="middle">
        hidden axes
      </text>
      {hidden.map((h) => (
        <g key={h.label}>
          <line x1={h.x} y1={58} x2={h.x} y2={176} stroke="rgba(110,168,254,0.18)" />
          <line x1={h.x - 5} y1={90} x2={h.x + 5} y2={90} stroke="#6ea8fe" strokeWidth="2" />
          <line x1={h.x - 5} y1={140} x2={h.x + 5} y2={140} stroke="rgba(110,168,254,0.4)" />
          <circle cx={h.x} cy={110} r={3} fill="#ffd166" />
          <text x={h.x} y={196} className="guide-svg-label" textAnchor="middle">
            {h.label}
          </text>
        </g>
      ))}
      <text x={98} y={216} className="guide-svg-label guide-svg-label--muted" textAnchor="middle">
        take the max over each
      </text>
      <line x1={186} y1={116} x2={224} y2={116} stroke="#6ea8fe" strokeWidth="1.4" markerEnd="url(#projection-arrow)" />
      <text x={205} y={104} className="guide-svg-label" textAnchor="middle">
        max
      </text>

      <rect x={238} y={46} width={138} height={138} rx={8} fill="#080b12" stroke="rgba(120,140,170,0.22)" />
      {heat.map((row, r) =>
        row.map((v, c) => (
          <rect
            key={`${r}-${c}`}
            x={242 + c * 22}
            y={50 + r * 22}
            width={21}
            height={21}
            fill={`rgba(122,209,81, ${0.06 + v * 0.86})`}
          />
        )),
      )}
      <text x={307} y={202} className="guide-svg-label" textAnchor="middle">
        visible tx × ty
      </text>
      <text x={307} y={218} className="guide-svg-label guide-svg-label--muted" textAnchor="middle">
        each cell = maximum over hidden axes
      </text>
    </svg>
  );
}

function GpuDiagram() {
  return (
    <svg className="guide-svg" viewBox="0 0 400 240" role="img" aria-labelledby="gpu-diagram-title">
      <title id="gpu-diagram-title">
        One GPU workgroup per candidate: 128 lanes score samples and reduce their sums in shared memory.
      </title>
      <defs>
        <marker id="gpu-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="#7ad151" />
        </marker>
      </defs>
      <rect width="400" height="240" rx="14" fill="#070a11" />
      <text x={20} y={30} className="guide-svg-label guide-svg-label--muted">
        one workgroup = one candidate affine
      </text>
      <rect x={20} y={42} width={176} height={112} rx={8} fill="#0a0f18" stroke="rgba(110,168,254,0.28)" />
      {Array.from({ length: 8 }, (_, i) => (
        <g key={i}>
          <rect x={30 + i * 20} y={54} width={14} height={64} rx={3} fill="rgba(110,168,254,0.12)" stroke="rgba(110,168,254,0.32)" />
          {[0, 1, 2].map((j) => (
            <circle key={j} cx={37 + i * 20} cy={68 + j * 16} r={2.4} fill={i < 6 ? '#6ea8fe' : '#3a4a63'} />
          ))}
        </g>
      ))}
      <text x={108} y={136} className="guide-svg-label guide-svg-label--muted" textAnchor="middle">
        128 lanes stride over N samples
      </text>
      <text x={108} y={148} className="guide-svg-label guide-svg-label--muted" textAnchor="middle">
        Σa Σb Σab Σa² Σb² n
      </text>

      <line x1={204} y1={98} x2={230} y2={98} stroke="#7ad151" strokeWidth="1.4" markerEnd="url(#gpu-arrow)" />

      <g stroke="rgba(122,209,81,0.35)" fill="rgba(122,209,81,0.13)">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <rect key={`l1${i}`} x={238 + i * 9} y={82} width={7} height={32} rx={2} />
        ))}
        {[0, 1, 2, 3].map((i) => (
          <rect key={`l2${i}`} x={242 + i * 18} y={62} width={7} height={20} rx={2} />
        ))}
        <rect x={260} y={40} width={10} height={16} rx={2} />
      </g>
      <text x={265} y={126} className="guide-svg-label guide-svg-label--muted" textAnchor="middle">
        tree reduce
      </text>
      <rect x={300} y={78} width={84} height={40} rx={9} fill="rgba(255,209,102,0.1)" stroke="rgba(255,209,102,0.4)" />
      <text x={342} y={102} className="guide-svg-label" textAnchor="middle">
        score_i
      </text>
      <text x={342} y={134} className="guide-svg-label guide-svg-label--muted" textAnchor="middle">
        NCC − penalty
      </text>

      <rect x={20} y={170} width={360} height={46} rx={8} fill="#0a0f18" stroke="rgba(120,140,170,0.2)" />
      <text x={34} y={190} className="guide-svg-label" textAnchor="start">
        dispatchWorkgroups(candidateCount)
      </text>
      <text x={34} y={207} className="guide-svg-label guide-svg-label--muted" textAnchor="start">
        candidates stream in batches of 8192; each workgroup is independent, so the GPU stays busy
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* page                                                               */
/* ------------------------------------------------------------------ */

const DOFS = [
  { key: 'tx, ty', meaning: 'translation in normalised image units', steps: '21 each' },
  { key: 'θ', meaning: 'rotation', steps: '15' },
  { key: 's', meaning: 'uniform scale', steps: '9' },
  { key: 'a', meaning: 'aspect sx / sy', steps: '7 (optional)' },
  { key: 'sh', meaning: 'shear', steps: '7 (optional)' },
];

const READOUTS = [
  {
    title: 'Heatmap',
    body: 'Score of the best transform for each cell. Brighter means better; black means this part of the space has not been searched yet.',
  },
  {
    title: 'Local optima',
    body: 'Isolated rings mark local maxima of the projected landscape. The white ring is the global best.',
  },
  {
    title: 'Crosshair',
    body: 'The yellow crosshair is the transform currently shown in the overlay. Hover a cell to preview its transform.',
  },
  {
    title: 'Explored cells',
    body: 'A dashed outline marks a cell you have already dived into. The thin blue rectangle is the current refined patch.',
  },
];

export function InfoPage({ onBack, onNew, onExample }: InfoPageProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onBack();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onBack]);

  return (
    <div className="guide" ref={scrollRef}>
      <header className="guide__topbar">
        <div className="guide__brand">
          <span className="guide__mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <div>
            <strong>mi-align</strong>
            <span className="guide__brand-sub">field guide</span>
          </div>
        </div>
        <div className="guide__topbar-actions">
          <a className="guide__text-link" href="#try">
            Examples
          </a>
          <button ref={closeRef} type="button" className="guide__button guide__button--primary" onClick={onBack}>
            ← Back
          </button>
        </div>
      </header>

      <section className="guide__hero">
        <div className="guide__hero-copy">
          <p className="guide__eyebrow">Affine alignment · NCC · mutual information · WebGPU</p>
          <h1>See the whole landscape.</h1>
          <p className="guide__lede">
            Image alignment is usually framed as an optimisation: start somewhere, follow a gradient, hope the
            optimum is nearby. This app does the opposite. It scores a whole grid of candidate transforms at once
            on the GPU and then draws the score landscape, so you can see the global optimum, the competing local
            optima, and the ridges between them.
          </p>
          <div className="guide__hero-actions">
            <button type="button" className="guide__button guide__button--primary" onClick={onBack}>
              Back to the app
            </button>
            <a className="guide__button" href="#mutual-information">
              Read the guide
            </a>
          </div>
        </div>
        <Figure caption="A candidate transform maps canonical coordinates of A into canonical coordinates of B: rotation, scale, aspect, shear and translation.">
          <TransformDiagram />
        </Figure>
      </section>

      <div className="guide__layout">
        <nav className="guide__toc" aria-label="Guide contents">
          <span className="guide__toc-title">In this guide</span>
          <a href="#alignment">01 · Alignment as a search</a>
          <a href="#ncc">02 · Scoring a candidate</a>
          <a href="#mutual-information">03 · Joint mutual information</a>
          <a href="#gpu">04 · Brute force on the GPU</a>
          <a href="#heatmap">05 · The N-D heatmap</a>
          <a href="#studio">06 · Reading the studio</a>
          <a href="#try">07 · Try these</a>
          <a href="#further-reading">08 · Further reading</a>
        </nav>

        <main className="guide__content">
          <section id="alignment" className="guide-section">
            <p className="guide-section__eyebrow">01 · Alignment as a search</p>
            <h2>Six numbers, one transform</h2>
            <p>
              Two images of the same scene rarely share a pixel grid. One may be rotated, zoomed, cropped, or
              photographed from a slightly different angle. For a planar scene, or for a small change of viewpoint,
              the relationship is well approximated by an <strong>affine transform</strong>.
            </p>
            <Formula>
              X_b = M · X_a + t{'\n'}
              M = R(θ) · Shear(sh) · Scale(s<sub>x</sub>, s<sub>y</sub>){'\n'}
              s<sub>x</sub> = s · a,&nbsp;&nbsp; s<sub>y</sub> = s / a
            </Formula>
            <p>
              That is six degrees of freedom: translation <code>tx, ty</code>, rotation <code>θ</code>, uniform
              scale <code>s</code>, aspect <code>a</code> and shear <code>sh</code>. The app stores all coordinates
              in a canonical frame so that the same numbers describe a 640×480 image and a 420×560 image:
            </p>
            <Formula>
              X = (p + 0.5 − W/2) / R,&nbsp;&nbsp; R = max(W, H) / 2
            </Formula>
            <p>
              Canonical coordinates therefore span roughly ±1 on the longer side. The transform is
              resolution-independent, which is why a small detail can be aligned to a larger overview without
              special cases.
            </p>
            <div className="guide-grid guide-grid--2">
              <div className="guide-card guide-card--soft">
                <h3>Why brute force?</h3>
                <p>
                  The score landscape is not convex. Rotating by 180° can look almost as plausible as the correct
                  orientation for a symmetric object, and local optima are real. A local method can stall; a dense
                  scan shows every basin at once.
                </p>
              </div>
              <div className="guide-card">
                <span className="guide-card__tag">In the studio</span>
                <h3>Lock the axes you know</h3>
                <p>
                  Every axis can be locked at a concrete value and excluded from the search. That turns the 6-D
                  problem into the slice you actually care about, and it multiplies the resolution you can afford
                  on the remaining axes.
                </p>
              </div>
            </div>
            <div className="guide-table-wrap">
              <table className="guide-table">
                <thead>
                  <tr>
                    <th>Axis</th>
                    <th>Meaning</th>
                    <th>Default steps</th>
                  </tr>
                </thead>
                <tbody>
                  {DOFS.map((dof) => (
                    <tr key={dof.key}>
                      <td>
                        <code>{dof.key}</code>
                      </td>
                      <td>{dof.meaning}</td>
                      <td>{dof.steps}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              The default search is <code>21 × 21 × 15 × 9 = 59,535</code> candidates. That is a lot of independent
              work — exactly the shape a GPU likes.
            </p>
          </section>

          <section id="ncc" className="guide-section">
            <p className="guide-section__eyebrow">02 · Scoring a candidate</p>
            <h2>Zero-mean NCC, minus an overlap penalty</h2>
            <p>
              To score a candidate, the app samples pixels from A, maps them through the candidate transform into
              B, and compares the two intensity sequences. The search objective is a zero-mean normalised cross
              correlation:
            </p>
            <Formula>
              NCC = Σ (a<sub>i</sub> − ā)(b<sub>i</sub> − b̄) / √( Σ(a<sub>i</sub> − ā)² · Σ(b<sub>i</sub> − b̄)² )
            </Formula>
            <p>
              NCC is invariant to brightness and contrast rescaling and lies in <code>[−1, 1]</code>. The mean is
              subtracted before correlating, so a constant offset cannot make two images look similar. The final
              score subtracts a penalty for samples that fall outside B:
            </p>
            <Formula>
              overlap = validSamples / totalSamples{'\n'}
              score = NCC − λ · (1 − overlap)
            </Formula>
            <p>
              Candidates below a minimum overlap are rejected outright. Without that guard, a tiny patch of B that
              happens to match a few samples could win by hiding most of the image outside the frame.
            </p>
            <div className="guide-grid guide-grid--2">
              <div className="guide-card">
                <span className="guide-card__tag">Fast</span>
                <h3>One pass, five sums</h3>
                <p>
                  The kernel only needs <code>Σa</code>, <code>Σb</code>, <code>Σab</code>, <code>Σa²</code>,{' '}
                  <code>Σb²</code> and the valid count. Those are accumulated while streaming the samples, then
                  reduced in shared memory.
                </p>
              </div>
              <div className="guide-card">
                <span className="guide-card__tag">Cheap to sample</span>
                <h3>You do not need every pixel</h3>
                <p>
                  A stratified grid, uniform random samples, or gradient-weighted samples near edges all work. The
                  cost is <code>candidates × samples</code>, so sampling is the main dial between speed and
                  certainty.
                </p>
              </div>
            </div>
            <div className="guide-callout">
              <strong>NCC is the search objective; MI is the honest readout.</strong> The dense scan uses NCC
              because it is cheap and precise for the examples. Mutual information is computed separately for the
              transform currently on screen, so you can check whether the alignment still holds when brightness
              changes.
            </div>
          </section>

          <section id="mutual-information" className="guide-section">
            <p className="guide-section__eyebrow">03 · Joint mutual information</p>
            <h2>Do the two images tell you about each other?</h2>
            <p>
              Mutual information asks a different question from correlation. Not “do the intensities rise
              together?” but “how much does knowing the intensity in A reduce the uncertainty about the intensity
              in B?” It is built from entropy:
            </p>
            <Formula>
              H(A) = −Σ<sub>a</sub> p(a) log<sub>2</sub> p(a){'\n'}
              H(A, B) = −Σ<sub>a,b</sub> p(a, b) log<sub>2</sub> p(a, b){'\n'}
              I(A;B) = H(A) + H(B) − H(A, B)
            </Formula>
            <p>
              Equivalently, compare the <strong>joint</strong> distribution of paired intensities with the product
              of the marginals:
            </p>
            <Formula>I(A;B) = Σ<sub>a,b</sub> p(a, b) log<sub>2</sub> [ p(a, b) / (p(a) · p(b)) ]</Formula>
            <p>
              The app normalises it to a bounded, easy-to-read number:
            </p>
            <Formula>NMI = 2 · I(A;B) / (H(A) + H(B))</Formula>
            <p>
              The joint histogram is the picture to keep in mind. If the images are aligned, a bright pixel in A
              tends to pair with a bright pixel in B, and the histogram collapses onto a diagonal. If they are
              misaligned, the pairs are scrambled and the histogram spreads out. MI measures how far the joint
              distribution has moved away from “independent”.
            </p>
            <Figure caption="Aligned images concentrate probability mass on the diagonal; misalignment spreads it. MI drops as the joint histogram approaches the product of the marginals.">
              <HistogramDiagram />
            </Figure>
            <div className="guide-grid guide-grid--2">
              <div className="guide-card">
                <span className="guide-card__tag">Why it matters</span>
                <h3>Beyond brightness</h3>
                <p>
                  MI is invariant under monotonic intensity remapping and does not assume a linear relationship. A
                  thermal camera and an optical camera can be aligned even when their intensities are not
                  comparable at all.
                </p>
              </div>
              <div className="guide-card">
                <span className="guide-card__tag">In this app</span>
                <h3>32 × 32 bins</h3>
                <p>
                  The measurement kernel bins both images into 32 intensity levels, builds a 32×32 joint histogram
                  in workgroup memory with atomics, derives the marginals, and reports MI in bits plus both
                  entropies. The histogram is drawn next to the value.
                </p>
              </div>
            </div>
            <div className="guide-callout">
              <strong>Reading the numbers.</strong> MI is in bits. NMI is in <code>[0, 1]</code>. A tight diagonal
              histogram and a high NMI mean the images agree; a smeared histogram means the transform is wrong — or
              that the two images genuinely show different things.
            </div>
          </section>

          <section id="gpu" className="guide-section">
            <p className="guide-section__eyebrow">04 · Brute force on the GPU</p>
            <h2>Tens of thousands of independent scores</h2>
            <p>
              A brute-force scan is embarrassingly parallel: every candidate can be scored without talking to any
              other candidate. The implementation leans on exactly that. The host builds the cartesian product of
              the enabled axes, packs each candidate as a 6-float affine, and uploads the matrices in batches.
            </p>
            <Figure caption="One workgroup per candidate. The 128 invocations stride over the source samples, then a tree reduction in shared memory produces one score.">
              <GpuDiagram />
            </Figure>
            <p>For each candidate, the WGSL kernel does the following:</p>
            <ol className="guide-list">
              <li>
                Each of the 128 invocations takes a strided subset of the sampled source pixels.
              </li>
              <li>
                The pixel is mapped through the candidate affine into image B and bilinearly sampled from a GPU
                texture.
              </li>
              <li>
                The invocation accumulates the six sums needed for NCC and overlap.
              </li>
              <li>
                A tree reduction combines the per-lane sums in workgroup shared memory.
              </li>
              <li>
                Invocation 0 computes NCC, overlap and the final score, and writes an 8-float row: score, NCC,
                overlap, mean A, mean B and padding.
              </li>
            </ol>
            <p>
              Candidates are streamed in chunks of 8,192: upload, dispatch, read back, repeat. The progress bar is
              real work, not a guess. Because each candidate is an independent workgroup, the GPU can keep many
              workgroups in flight and hide memory latency.
            </p>
            <div className="guide-grid guide-grid--3">
              <div className="guide-card">
                <h3>Search kernel</h3>
                <p>
                  One workgroup per candidate, 128 invocations, strided samples, shared-memory reduction. Cost is
                  linear in candidates.
                </p>
              </div>
              <div className="guide-card">
                <h3>MI kernel</h3>
                <p>
                  One workgroup for a single transform. Builds a 32×32 joint histogram with atomics, then reduces
                  MI, NMI, entropies, NCC and overlap.
                </p>
              </div>
              <div className="guide-card">
                <h3>Why it fits</h3>
                <p>
                  No inter-workgroup communication, almost no branching, and a small fixed amount of shared memory
                  per candidate. That is the ideal brute-force workload.
                </p>
              </div>
            </div>
            <Formula>
              work ≈ candidates × samples{'\n'}
              59,535 × 2,048 ≈ 122 million sample fetches
            </Formula>
            <p>
              The alternative — a CPU loop or a per-candidate draw call — would turn that into a scheduling
              problem. On the GPU it is one dispatch per batch.
            </p>
          </section>

          <section id="heatmap" className="guide-section">
            <p className="guide-section__eyebrow">05 · The N-D heatmap</p>
            <h2>A 6-D landscape, projected to two axes</h2>
            <p>
              A six-dimensional score field cannot be drawn at once. Pick two axes and, for every cell, take the
              <strong> maximum over all the remaining axes</strong>. The result is a shadow of the full landscape:
              an isolated peak in the shadow is a genuine local optimum of the full space.
            </p>
            <Figure caption="Max-projection: each visible cell keeps the best score it found anywhere along the hidden axes.">
              <ProjectionDiagram />
            </Figure>
            <p>
              Switch to <strong>slice at best</strong> to see a true 2-D cross-section instead: the hidden axes are
              frozen at the value of the best transform, and each cell is the score of exactly that transform.
              Hover a cell to resolve the hidden values and preview the exact transform in the overlay.
            </p>
            <div className="guide-grid guide-grid--2">
              <div className="guide-card guide-card--soft">
                <h3>Explore, don’t restart</h3>
                <p>
                  The heatmap is a free camera over parameter space. Pan and zoom as far as you like; the grid,
                  ticks and hit testing follow the pointer immediately, while the search for the visible window
                  catches up a moment later.
                </p>
              </div>
              <div className="guide-card">
                <span className="guide-card__tag">Detail pyramid</span>
                <h3>Zoom into a finer grid</h3>
                <p>
                  When navigation settles, the visible window is re-searched with the same step count, producing a
                  finer layer. Coarser layers stay visible around and behind it, and every layer shares one colour
                  scale, so the refined patch is directly comparable with its surroundings.
                </p>
              </div>
            </div>
            <div className="guide-callout">
              <strong>Dive into a cell.</strong> Double-click a cell, or select it and choose <em>dive inside this
              cell</em>, to re-search only that neighbourhood with the hidden axes frozen. The breadcrumbs keep
              the stack so you can walk back up.
            </div>
          </section>

          <section id="studio" className="guide-section">
            <p className="guide-section__eyebrow">06 · Reading the studio</p>
            <h2>What the picture is telling you</h2>
            <div className="guide-legend">
              <div className="guide-legend__item">
                <span className="guide-legend__swatch guide-legend__swatch--heat" />
                <span>
                  <strong>Heatmap</strong> — score landscape. Brighter is better; black means “not searched yet”.
                </span>
              </div>
              <div className="guide-legend__item">
                <span className="guide-legend__crosshair">+</span>
                <span>
                  <strong>Crosshair</strong> — the transform currently shown in the overlay.
                </span>
              </div>
              <div className="guide-legend__item">
                <span className="guide-legend__ring" />
                <span>
                  <strong>Optima</strong> — local maxima of the projected landscape. The white ring is the global
                  best.
                </span>
              </div>
              <div className="guide-legend__item">
                <span className="guide-legend__dash" />
                <span>
                  <strong>Explored cell</strong> — already dived into. A dashed border marks it.
                </span>
              </div>
            </div>
            <div className="guide-table-wrap">
              <table className="guide-table">
                <thead>
                  <tr>
                    <th>Readout</th>
                    <th>What it means</th>
                  </tr>
                </thead>
                <tbody>
                  {READOUTS.map((item) => (
                    <tr key={item.title}>
                      <td>{item.title}</td>
                      <td>{item.body}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="guide-grid guide-grid--2">
              <div className="guide-card">
                <h3>Mouse</h3>
                <p>
                  Drag the moving image to translate. <kbd>shift</kbd>+drag sideways to rotate.{' '}
                  <kbd>ctrl</kbd>+drag radially to scale. <kbd>ctrl</kbd>+wheel zooms out. In the heatmap, drag to
                  pan and wheel to zoom.
                </p>
              </div>
              <div className="guide-card">
                <h3>Keyboard and layers</h3>
                <p>
                  Click a cell to select it, then use <em>dive inside this cell</em>. <em>← up</em> walks back down
                  the stack. Lock any axis from the search panel to slice through the space at a fixed rotation or
                  scale.
                </p>
              </div>
            </div>
          </section>

          <section id="try" className="guide-section">
            <p className="guide-section__eyebrow">07 · Try these</p>
            <h2>Short tours through the landscape</h2>
            <p>
              Every example ships with an exact ground-truth transform, so the error is shown live. Open one and
              watch the score map, the joint histogram and the overlay together.
            </p>
            <div className="guide-preset-grid">
              {EXAMPLES.map((example) => (
                <button key={example.id} type="button" className="guide-preset" onClick={() => onExample(example)}>
                  <span className="guide-preset__meta">{example.tag}</span>
                  <span className="guide-preset__name">{example.label}</span>
                  <span className="guide-preset__desc">{example.blurb}</span>
                  <span className="guide-preset__action">Open in studio →</span>
                </button>
              ))}
              <button type="button" className="guide-preset guide-preset--new" onClick={onNew}>
                <span className="guide-preset__meta">your own pair</span>
                <span className="guide-preset__name">Start a new project</span>
                <span className="guide-preset__desc">
                  Drop two images of any size and aspect ratio. The search space starts from the app defaults.
                </span>
                <span className="guide-preset__action">New project →</span>
              </button>
            </div>
          </section>

          <section id="further-reading" className="guide-section">
            <p className="guide-section__eyebrow">08 · Further reading</p>
            <h2>Go deeper</h2>
            <div className="guide-links">
              <a href="https://en.wikipedia.org/wiki/Affine_transformation" target="_blank" rel="noreferrer">
                Affine transformation
              </a>
              <a href="https://en.wikipedia.org/wiki/Cross-correlation" target="_blank" rel="noreferrer">
                Cross-correlation
              </a>
              <a href="https://en.wikipedia.org/wiki/Mutual_information" target="_blank" rel="noreferrer">
                Mutual information
              </a>
              <a href="https://en.wikipedia.org/wiki/Joint_entropy" target="_blank" rel="noreferrer">
                Joint entropy
              </a>
              <a href="https://en.wikipedia.org/wiki/Image_registration" target="_blank" rel="noreferrer">
                Image registration
              </a>
              <a href="https://en.wikipedia.org/wiki/WebGPU" target="_blank" rel="noreferrer">
                WebGPU
              </a>
              <a href="https://www.w3.org/TR/WGSL/" target="_blank" rel="noreferrer">
                WGSL specification
              </a>
              <a href="https://en.wikipedia.org/wiki/Normalized_cross-correlation" target="_blank" rel="noreferrer">
                Normalised cross-correlation
              </a>
            </div>
            <p className="guide-note">
              The app is a WebGPU experiment: the search and the MI measurement both run in WGSL compute shaders on
              your own GPU. No images leave the browser.
            </p>
          </section>
        </main>
      </div>

      <footer className="guide__footer">
        <div>
          <strong>mi-align</strong> — affine image alignment with a WebGPU brute-force search and a mutual
          information readout.
        </div>
        <button type="button" className="guide__button guide__button--primary" onClick={onBack}>
          ← Back
        </button>
      </footer>
    </div>
  );
}
