import { useCallback, useEffect, useState } from "react";
import type { CasStack } from "@unicas/protocol-admin";
import { api } from "../api.js";
import { ErrorState, LoadingState, Page, Tabs } from "../components.js";
import { formatErrorSafe } from "./view-helpers.js";
import { StackOverviewView } from "./stack-overview.js";
import { MembersView } from "./members.js";
import { IssuerView } from "./issuer.js";
import { RefDomainsView } from "./ref-domains.js";
import { ControlAuditView } from "./control-audit.js";
import { RootRefAuditView, UsageView } from "./placeholder-views.js";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "members", label: "Members" },
  { id: "issuer", label: "Issuer & keys" },
  { id: "domains", label: "Ref domains" },
  { id: "audit", label: "Control audit" },
  { id: "root-refs", label: "Root Ref audit" },
  { id: "usage", label: "Usage" },
] as const;

export function StackView({ stackId }: { stackId: string }) {
  const [stack, setStack] = useState<CasStack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<string>("overview");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStack(await api<CasStack>(`/admin/stacks/${encodeURIComponent(stackId)}`));
    } catch (caught) {
      setError(formatErrorSafe(caught));
    }
  }, [stackId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const reload = () => setReloadKey((key) => key + 1);

  if (error) return <Page title="Stack"><ErrorState message={error} /></Page>;
  if (!stack) return <Page title="Stack"><LoadingState /></Page>;

  return (
    <Page
      title={stack.displayName}
      actions={<a href="#/">← My Stacks</a>}
    >
      <p className="muted">{stack.stackId} · status {stack.status} · revision {stack.revision}</p>
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === "overview" ? <StackOverviewView stack={stack} onChanged={reload} /> : null}
      {tab === "members" ? <MembersView stackId={stackId} stackRevision={stack.revision} onChanged={reload} /> : null}
      {tab === "issuer" ? <IssuerView stackId={stackId} /> : null}
      {tab === "domains" ? <RefDomainsView stackId={stackId} /> : null}
      {tab === "audit" ? <ControlAuditView stackId={stackId} /> : null}
      {tab === "root-refs" ? <RootRefAuditView stackId={stackId} /> : null}
      {tab === "usage" ? <UsageView stackId={stackId} /> : null}
    </Page>
  );
}
