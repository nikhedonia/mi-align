import type { ViewOpts } from '../gpu/warp';
import { VIEW_MODES } from '../gpu/warp';

interface Props {
  opts: ViewOpts;
  onChange: (o: ViewOpts) => void;
}

export function ViewBar({ opts, onChange }: Props) {
  return (
    <div className="viewBar">
      <div className="segmented small">
        {VIEW_MODES.map((m) => (
          <button
            key={m.id}
            className={opts.mode === m.id ? 'active' : ''}
            onClick={() => onChange({ ...opts, mode: m.id })}
          >
            {m.label}
          </button>
        ))}
      </div>
      <label className="slider">
        <span>opacity</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={opts.opacity}
          onChange={(e) => onChange({ ...opts, opacity: parseFloat(e.target.value) })}
        />
      </label>
      {opts.mode === 1 ? (
        <label className="slider">
          <span>gain</span>
          <input
            type="range"
            min={0.5}
            max={10}
            step={0.1}
            value={opts.gain}
            onChange={(e) => onChange({ ...opts, gain: parseFloat(e.target.value) })}
          />
        </label>
      ) : null}
      {opts.mode === 2 ? (
        <label className="slider">
          <span>checker</span>
          <input
            type="range"
            min={6}
            max={80}
            step={1}
            value={opts.checker}
            onChange={(e) => onChange({ ...opts, checker: parseInt(e.target.value, 10) })}
          />
        </label>
      ) : null}
    </div>
  );
}
