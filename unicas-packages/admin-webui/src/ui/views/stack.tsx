import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Boxes,
  Database,
  Gauge,
  KeyRound,
  LayoutDashboard,
  ScrollText,
  Users,
} from "lucide-react";
import type { CasStack } from "@unicas/protocol-admin";
import { api } from "../api.js";
import { ErrorState, LoadingState, Page, Tabs } from "../components.js";
import { navigate } from "../router.js";
import { formatErrorSafe } from "./view-helpers.js";
import { StackOverviewView } from "./stack-overview.js";
import { MembersView } from "./members.js";
import { IssuerView } from "./issuer.js";
import { RefDomainsView } from "./ref-domains.js";
import { ControlAuditView } from "./control-audit.js";
import { RootRefAuditView, UsageView } from "./placeholder-views.js";

const TABS = [
  { id: "overview", label: "Overview", icon: <LayoutDashboard size={15} /> },
  { id: "members", label: "Members", icon: <Users size={15} /> },
  { id: "issuer", label: "Issuer & keys", icon: <KeyRound size={15} /> },
  { id: "domains", label: "Ref domains", icon: <Boxes size={15} /> },
  { id: "audit", label: "Control audit", icon: <ScrollText size={15} /> },
  { id: "root-refs", label: "Root Ref audit", icon: <Database size={15} /> },
  { id: "usage", label: "Usage", icon: <Gauge size={15} /> },
] as const;

export function StackView({ stackId }: { stackId: string }) {
  const [stack, setStack] = useState<CasStack | null>(null);
  const [stacks, setStacks] = useState<CasStack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<string>("overview");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [currentStack, stackList] = await Promise.all([
        api<CasStack>(`/admin/stacks/${encodeURIComponent(stackId)}`),
        api<{ items: CasStack[] }>("/admin/stacks"),
      ]);
      setStack(currentStack);
      setStacks(stackList.items);
    } catch (caught) {
      setError(formatErrorSafe(caught));
    }
  }, [stackId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const reload = () => setReloadKey((key) => key + 1);

  if (error) return <Page title="Stack"><ErrorState message={error} /></Page>;
  if (!stack || !stacks) return <Page title="Stack"><LoadingState /></Page>;

  return (
    <Page
      title={stack.displayName}
      actions={<a className="back-link" href="#/"><ArrowLeft size={15} />My Stacks</a>}
    >
      <div className="stack-meta">
        <code>{stack.stackId}</code>
        <span className="status-badge">{stack.status}</span>
        <span>revision {stack.revision}</span>
      </div>
      <div className="stack-layout">
        <aside className="stack-sidebar" aria-label="Stack management navigation">
          <div className="stack-switcher">
            <label htmlFor="stack-switcher">Stack</label>
            <select
              id="stack-switcher"
              value={stackId}
              onChange={(event) => navigate(`/stacks/${encodeURIComponent(event.target.value)}`)}
            >
              {stacks.map((option) => (
                <option key={option.stackId} value={option.stackId}>{option.displayName}</option>
              ))}
            </select>
          </div>
          <Tabs tabs={TABS} active={tab} onChange={setTab} orientation="vertical" />
        </aside>
        <section className="stack-content">
          {tab === "overview" ? <StackOverviewView stack={stack} onChanged={reload} /> : null}
          {tab === "members" ? <MembersView stackId={stackId} stackRevision={stack.revision} onChanged={reload} /> : null}
          {tab === "issuer" ? <IssuerView stackId={stackId} /> : null}
          {tab === "domains" ? <RefDomainsView stackId={stackId} /> : null}
          {tab === "audit" ? <ControlAuditView stackId={stackId} /> : null}
          {tab === "root-refs" ? <RootRefAuditView stackId={stackId} /> : null}
          {tab === "usage" ? <UsageView stackId={stackId} /> : null}
        </section>
      </div>
    </Page>
  );
}
