import type { ReactNode } from "react";

export function Page({ title, actions, children }: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="page">
      <header className="page-header">
        <h1>{title}</h1>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="card">
      {title ? <h2 className="card-title">{title}</h2> : null}
      {children}
    </div>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return <div className="state loading" role="status">{label}</div>;
}

export function EmptyState({ message }: { message: string }) {
  return <div className="state empty">{message}</div>;
}

export function ErrorState({ message }: { message: string }) {
  return <div className="state error" role="alert">{message}</div>;
}

export function NotAvailableState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="state unavailable">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

export function Button({ children, onClick, disabled, variant }: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "danger" | "plain";
}) {
  return (
    <button
      type="button"
      className={`btn${variant ? ` btn-${variant}` : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function Table({ columns, rows, empty }: {
  columns: readonly string[];
  rows: readonly (readonly ReactNode[])[];
  empty: string;
}) {
  if (rows.length === 0) return <EmptyState message={empty} />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: {
  tabs: readonly { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <nav className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={`tab${tab.id === active ? " tab-active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "unexpected error";
}
