import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Last-resort renderer guard: shows the error and a reload button instead of a blank window. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] uncaught render error:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="crash">
        <h2>crewdeck hit an unexpected error</h2>
        <pre>{error.message}</pre>
        <button type="button" onClick={() => window.location.reload()}>
          Reload window
        </button>
      </div>
    );
  }
}
