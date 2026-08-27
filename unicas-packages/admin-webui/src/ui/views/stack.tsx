import { useCallback, useEffect, useRef, useState } from "react";
import {
  Boxes,
  Database,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  ScrollText,
  Users,
  X,
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

export function StackView({ stackId, onLogout }: { stackId: string; onLogout: () => void }) {
  const [stack, setStack] = useState<CasStack | null>(null);
  const [stacks, setStacks] = useState<CasStack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<string>("overview");
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const navigationCloseRef = useRef<HTMLButtonElement>(null);
  const navigationDrawerRef = useRef<HTMLElement>(null);

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

  useEffect(() => {
    if (!mobileNavigationOpen) return;
    document.body.classList.add("drawer-open");
    const focusTimer = window.setTimeout(() => navigationCloseRef.current?.focus(), 200);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMobileNavigation();
        return;
      }
      if (event.key !== "Tab" || !navigationDrawerRef.current) return;
      const focusable = Array.from(navigationDrawerRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      ));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.classList.remove("drawer-open");
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileNavigationOpen]);

  useEffect(() => {
    setMobileNavigationOpen(false);
  }, [stackId]);

  const reload = () => setReloadKey((key) => key + 1);
  const activeTab = TABS.find((item) => item.id === tab) ?? TABS[0];

  function closeMobileNavigation() {
    setMobileNavigationOpen(false);
    requestAnimationFrame(() => navigationButtonRef.current?.focus());
  }

  function selectTab(id: string) {
    setTab(id);
    if (mobileNavigationOpen) closeMobileNavigation();
  }

  if (error) return <Page title="Stack"><ErrorState message={error} /></Page>;
  if (!stack || !stacks) return <Page title="Stack"><LoadingState /></Page>;

  return (
    <Page
      title={stack.displayName}
      meta={(
        <div className="stack-meta">
          <code>{stack.stackId}</code>
          <span className="status-badge">{stack.status}</span>
          <span>revision {stack.revision}</span>
        </div>
      )}
    >
      <button
        ref={navigationButtonRef}
        type="button"
        className="mobile-nav-trigger"
        aria-controls="stack-navigation"
        aria-expanded={mobileNavigationOpen}
        aria-label={`Open navigation, current section ${activeTab.label}`}
        title={`Navigation: ${activeTab.label}`}
        onClick={() => setMobileNavigationOpen(true)}
      >
        <Menu size={19} />
      </button>
      <div className="stack-layout">
        {mobileNavigationOpen ? (
          <div
            className="drawer-overlay"
            aria-hidden="true"
            onClick={closeMobileNavigation}
          />
        ) : null}
        <aside
          ref={navigationDrawerRef}
          id="stack-navigation"
          className={`stack-sidebar${mobileNavigationOpen ? " stack-sidebar-open" : ""}`}
          role={mobileNavigationOpen ? "dialog" : undefined}
          aria-modal={mobileNavigationOpen ? true : undefined}
          aria-label="Stack management navigation"
        >
          <div className="drawer-header">
            <a className="drawer-brand" href="#/">
              <span className="brand-mark">U</span>
              <span>UniCAS Admin</span>
            </a>
            <button
              ref={navigationCloseRef}
              type="button"
              className="drawer-close"
              aria-label="Close navigation"
              onClick={closeMobileNavigation}
            >
              <X size={17} />
            </button>
          </div>
          <div className="stack-switcher">
            <label htmlFor="stack-switcher">Stack</label>
            <select
              id="stack-switcher"
              value={stackId}
              onChange={(event) => {
                navigate(`/stacks/${encodeURIComponent(event.target.value)}`);
                if (mobileNavigationOpen) closeMobileNavigation();
              }}
            >
              {stacks.map((option) => (
                <option key={option.stackId} value={option.stackId}>{option.displayName}</option>
              ))}
            </select>
          </div>
          <Tabs tabs={TABS} active={tab} onChange={selectTab} orientation="vertical" />
          <div className="drawer-footer">
            <button type="button" className="drawer-signout" onClick={onLogout}>
              <LogOut size={15} />
              <span>Sign out</span>
            </button>
          </div>
        </aside>
        <section className="stack-content" aria-hidden={mobileNavigationOpen ? true : undefined}>
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
