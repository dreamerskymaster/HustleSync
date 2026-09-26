import React from 'react';

// A render crash used to unmount the whole tree and leave a white screen, which
// tells the user nothing and tells us nothing. Adding a job blanked the app for
// real users and the only way to diagnose it was to guess. Now the error is on
// screen, copyable, and reportable.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Render crash:', error, info && info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const detail = [error.name, error.message].filter(Boolean).join(': ');

    return (
      <div className="flex min-h-[100svh] items-center justify-center bg-paper p-4">
        <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6">
          <h1 className="font-display text-2xl font-semibold tracking-wide text-ink">
            Something broke on this screen
          </h1>
          <p className="mt-2 text-graphite">
            Your saved jobs are safe. This is a fault in the app, not in your data.
          </p>
          <p className="mt-4 rounded-xl border border-line bg-paper p-3 font-mono text-sm text-ember">
            {detail || 'No details available.'}
          </p>
          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="min-h-12 flex-1 rounded-xl border border-line font-bold text-graphite transition-colors hover:bg-paper"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="min-h-12 flex-1 rounded-xl bg-ink font-bold text-white transition-colors hover:bg-graphite"
            >
              Reload
            </button>
          </div>
          <p className="mt-4 text-sm text-ash">
            If it keeps happening, send that message above. It names the exact fault.
          </p>
        </div>
      </div>
    );
  }
}
