import type { ReactNode } from "react";
import { BookOpenText, CircleAlert, CircleDashed, Inbox, LoaderCircle } from "lucide-react";

export function Page({ title, meta, actions, children }: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="page">
      <header className="page-header">
        <div className="page-heading">
          <h1>{title}</h1>
          {meta}
        </div>
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

export function ConceptGuide({ title, summary, concepts }: {
  title: string;
  summary: string;
  concepts: readonly { term: string; detail: string }[];
}) {
  return (
    <aside className="concept-guide" aria-labelledby={`concept-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
      <BookOpenText className="concept-guide-icon" size={18} aria-hidden="true" />
      <div className="concept-guide-content">
        <p className="concept-guide-label">About this page</p>
        <h2 id={`concept-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{title}</h2>
        <p className="concept-guide-summary">{summary}</p>
        <dl className="concept-list">
          {concepts.map((concept) => (
            <div key={concept.term}>
              <dt>{concept.term}</dt>
              <dd>{concept.detail}</dd>
            </div>
          ))}
        </dl>
      </div>
    </aside>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state loading" role="status">
      <LoaderCircle className="state-icon spin" size={18} />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="state empty">
      <Inbox className="state-icon" size={18} />
      <span>{message}</span>
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="state error" role="alert">
      <CircleAlert className="state-icon" size={18} />
      <span>{message}</span>
    </div>
  );
}

export function NotAvailableState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="state unavailable">
      <CircleDashed className="state-icon" size={18} />
      <div><strong>{title}</strong><p>{detail}</p></div>
    </div>
  );
}

export function Button({ children, icon, onClick, disabled, variant }: {
  children: ReactNode;
  icon?: ReactNode;
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
      {icon ? <span className="btn-icon" aria-hidden="true">{icon}</span> : null}
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

export function Tabs({ tabs, active, onChange, orientation = "horizontal" }: {
  tabs: readonly { id: string; label: string; icon?: ReactNode }[];
  active: string;
  onChange: (id: string) => void;
  orientation?: "horizontal" | "vertical";
}) {
  return (
    <nav className={`tabs tabs-${orientation}`} role="tablist" aria-orientation={orientation}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={`tab tab-${orientation}${tab.id === active ? " tab-active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.icon ? <span className="tab-icon" aria-hidden="true">{tab.icon}</span> : null}
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
