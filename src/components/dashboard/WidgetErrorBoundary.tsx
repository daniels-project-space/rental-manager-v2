"use client";
import { Component, type ReactNode } from "react";

type Props = { children: ReactNode; label: string };
type State = { error: Error | null };

export class WidgetErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[widget:${this.props.label}]`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          className="rounded-lg p-4 text-xs"
          style={{
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.25)",
            color: "#fca5a5",
          }}
        >
          <div className="font-semibold mb-1" style={{ color: "#ef4444" }}>
            {this.props.label} failed to render
          </div>
          <div className="opacity-80">{this.state.error.message}</div>
        </div>
      );
    }
    return this.props.children;
  }
}
