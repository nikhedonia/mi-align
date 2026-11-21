import { useEffect, useState } from 'react';

interface Props {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  digits?: number;
  suffix?: string;
  title?: string;
  disabled?: boolean;
  width?: number;
}

function fmt(v: number, digits: number): string {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(digits);
  return s.replace(/\.?0+$/, '') || '0';
}

/** number input that lets you type freely ("-", "0.") but commits only valid numbers */
export function NumInput({ value, onChange, step = 0.01, min, max, digits = 3, suffix, title, disabled, width }: Props) {
  const [text, setText] = useState(() => fmt(value, digits));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(fmt(value, digits));
  }, [value, focused, digits]);

  return (
    <span className="numWrap" style={width ? { width } : undefined}>
      <input
        className="num"
        type="text"
        inputMode="decimal"
        disabled={disabled}
        title={title}
        value={text}
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.select();
        }}
        onBlur={() => {
          setFocused(false);
          setText(fmt(value, digits));
        }}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) {
            let c = v;
            if (min !== undefined) c = Math.max(min, c);
            if (max !== undefined) c = Math.min(max, c);
            onChange(c);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const dir = e.key === 'ArrowUp' ? 1 : -1;
            let c = value + dir * step;
            if (min !== undefined) c = Math.max(min, c);
            if (max !== undefined) c = Math.min(max, c);
            onChange(c);
            setText(fmt(c, digits));
          }
        }}
      />
      {suffix ? <span className="suffix">{suffix}</span> : null}
    </span>
  );
}
