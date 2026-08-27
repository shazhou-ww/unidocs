import { useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";

export function McpConfigurationDialog({ open, onClose }: {
  open: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<"url" | "prompt" | "cli" | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const serverUrl = `${window.location.origin}/mcp`;
  const skillUrl = `${window.location.origin}/admin/assets/skills/unicas-cli/SKILL.md`;
  const configurationPrompt = `Add a remote MCP server named "UniCAS" with this URL: ${serverUrl}
Use Streamable HTTP. Authentication is handled with OAuth in the browser; no API key is required.`;
  const cliPrompt = `Install the UniCAS CLI and its agent skill, then operate the control plane with it:
1. Install the CLI (from the UniCAS repository):
   pnpm --filter @unicas/cli build && pnpm install --global ./unicas-packages/cli
2. Log in once in a browser: unicas login
3. Install the agent skill, which tells you when and how to use the CLI:
   fetch ${skillUrl} and save it as ~/.agents/skills/unicas-cli/SKILL.md (DeepSeek Harness)
   or ~/.claude/skills/unicas-cli/SKILL.md (Claude Code), then follow it
4. Use the CLI (JSON on stdout) or connect over stdio MCP:
   unicas whoami | unicas stacks list | unicas stacks get <stackId> | unicas stacks create "Operations" --idempotency-key ops-1
   stdio MCP: command "unicas", args ["mcp"]`;

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add("modal-open");
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
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
      document.body.classList.remove("modal-open");
      window.removeEventListener("keydown", onKeyDown);
      openerRef.current?.focus();
    };
  }, [open, onClose]);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

  async function copy(value: string, target: "url" | "prompt" | "cli") {
    await navigator.clipboard.writeText(value);
    setCopied(target);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(null), 1800);
  }

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="mcp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-dialog-title"
        aria-describedby="mcp-dialog-description"
      >
        <div className="mcp-dialog-header">
          <div>
            <p className="dialog-eyebrow">Remote server</p>
            <h2 id="mcp-dialog-title">Connect an AI tool</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="dialog-close"
            aria-label="Close AI tool connection"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <p id="mcp-dialog-description" className="mcp-dialog-description">
          Use the server URL directly, or paste a prompt into your AI tool — the MCP prompt for
          tools that manage MCP connections, or the CLI prompt for tools that cannot handle
          OAuth MCP.
        </p>
        <button
          type="button"
          className="mcp-url-bubble"
          aria-label="Copy MCP server URL"
          title="Click to copy the MCP server URL"
          onClick={() => void copy(serverUrl, "url")}
        >
          {serverUrl}
          {copied === "url" ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <div className="mcp-config-heading mcp-prompt-heading">
          <code>Configuration prompt</code>
          <button type="button" className="copy-button" onClick={() => void copy(configurationPrompt, "prompt")}>
            {copied === "prompt" ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied === "prompt" ? "Prompt copied" : "Copy prompt"}</span>
          </button>
        </div>
        <pre className="mcp-config mcp-config-prompt"><code>{configurationPrompt}</code></pre>
        <div className="mcp-config-heading mcp-cli-prompt-heading">
          <code>CLI prompt</code>
          <button type="button" className="copy-button" onClick={() => void copy(cliPrompt, "cli")}>
            {copied === "cli" ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied === "cli" ? "CLI prompt copied" : "Copy CLI prompt"}</span>
          </button>
        </div>
        <pre className="mcp-config mcp-config-prompt"><code>{cliPrompt}</code></pre>
        <div className="mcp-auth-note">
          <strong>No API key required</strong>
          <p>On first use, your AI tool opens a browser and asks you to approve UniCAS access.</p>
        </div>
      </div>
    </div>
  );
}
