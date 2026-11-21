import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** changing this remounts the boundary, e.g. when the view changes */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
  info: string;
}

/**
 * A render error must never leave a blank page. Show what broke and offer the
 * two useful actions (retry / reload).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[mi-align] render error', error, info.componentStack);
    this.setState({ info: (info.componentStack ?? '').split('\n').slice(0, 8).join('\n') });
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, info: '' });
    }
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crashCard">
        <h2>Something broke in the interface</h2>
        <p className="mono small">{String(error.message || error)}</p>
        {info ? <pre className="crashStack">{info}</pre> : null}
        <div className="row gap">
          <button className="primary" onClick={() => this.setState({ error: null, info: '' })}>
            Try again
          </button>
          <button className="ghost" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
        <p className="hint">
          The GPU work is unaffected — if this keeps happening, note the message above and reload.
        </p>
      </div>
    );
  }
}
