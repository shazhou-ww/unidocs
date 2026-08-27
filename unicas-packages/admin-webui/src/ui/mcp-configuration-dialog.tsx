import { useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";

export function McpConfigurationDialog({ open, onClose }: {
  open: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<"url" | "prompt" | "cli" | "cli-prompt" | "skill" | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const serverUrl = `${window.location.origin}/mcp`;
  const configurationPrompt = `Add a remote MCP server named "UniCAS" with this URL: ${serverUrl}
Use Streamable HTTP. Authentication is handled with OAuth in the browser; no API key is required.`;
  const cliSetup = `# once per machine, from the UniCAS repository checkout
pnpm --filter @unicas/cli build
pnpm install --global ./unicas-packages/cli
unicas login

# everyday control-plane operations (JSON on stdout)
unicas whoami
unicas stacks list
unicas stacks create "Operations" --idempotency-key ops-1`;
  const cliPrompt = `For AI tools that cannot manage OAuth-protected MCP connections, use the UniCAS CLI instead.
Install once from the UniCAS repository, then log in with a browser:
  pnpm --filter @unicas/cli build && pnpm install --global ./unicas-packages/cli && unicas login
Operate the control plane with shell commands (JSON output):
  unicas whoami | unicas stacks list | unicas stacks get <stackId> | unicas stacks create "Operations" --idempotency-key ops-1
Or connect over stdio MCP: command "unicas", args ["mcp"].`;
  const skillInstallPrompt = `The UniCAS repository ships an agent skill that teaches AI tools when and how to use the unicas CLI.
If you are working inside the repository, it is already available; load it from:
  .agents/skills/unicas-cli/SKILL.md   (DeepSeek Harness / DSH)
  .claude/skills/unicas-cli/SKILL.md   (Claude Code / Copilot)
If you work outside the repository, install it into your user skills directory first:
  DSH:         Copy-Item -Recurse .agents\\skills\\unicas-cli $HOME\\.agents\\skills\\
  Claude Code: Copy-Item -Recurse .claude\\skills\\unicas-cli $HOME\\.claude\\skills\\
Then follow the skill: run "unicas login" once, then use "unicas whoami", "unicas stacks list", and the other control-plane commands.`;

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

  async function copy(value: string, target: "url" | "prompt" | "cli" | "cli-prompt" | "skill") {
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
          Use the server URL directly, paste the prompt into an AI tool that can manage MCP
          connections, or use the CLI alternative for tools that cannot handle OAuth MCP.
        </p>
        <div className="mcp-config-heading">
          <code>MCP server URL</code>
          <button type="button" className="copy-button" onClick={() => void copy(serverUrl, "url")}>
            {copied === "url" ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied === "url" ? "URL copied" : "Copy URL"}</span>
          </button>
        </div>
        <pre className="mcp-config mcp-config-url"><code>{serverUrl}</code></pre>
        <div className="mcp-config-heading mcp-prompt-heading">
          <code>Configuration prompt</code>
          <button type="button" className="copy-button" onClick={() => void copy(configurationPrompt, "prompt")}>
            {copied === "prompt" ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied === "prompt" ? "Prompt copied" : "Copy prompt"}</span>
          </button>
        </div>
        <pre className="mcp-config mcp-config-prompt"><code>{configurationPrompt}</code></pre>
        <div className="mcp-cli-section">
          <div className="mcp-config-heading mcp-cli-heading">
            <code>CLI setup &amp; usage</code>
            <button type="button" className="copy-button" onClick={() => void copy(cliSetup, "cli")}>
              {copied === "cli" ? <Check size={14} /> : <Copy size={14} />}
              <span>{copied === "cli" ? "Setup copied" : "Copy setup"}</span>
            </button>
          </div>
          <pre className="mcp-config mcp-config-cli"><code>{cliSetup}</code></pre>
          <div className="mcp-config-heading mcp-cli-prompt-heading">
            <code>CLI prompt</code>
            <button type="button" className="copy-button" onClick={() => void copy(cliPrompt, "cli-prompt")}>
              {copied === "cli-prompt" ? <Check size={14} /> : <Copy size={14} />}
              <span>{copied === "cli-prompt" ? "CLI prompt copied" : "Copy CLI prompt"}</span>
            </button>
          </div>
          <pre className="mcp-config mcp-config-prompt"><code>{cliPrompt}</code></pre>
          <div className="mcp-config-heading mcp-cli-prompt-heading">
            <code>Agent skill install</code>
            <button type="button" className="copy-button" onClick={() => void copy(skillInstallPrompt, "skill")}>
              {copied === "skill" ? <Check size={14} /> : <Copy size={14} />}
              <span>{copied === "skill" ? "Skill prompt copied" : "Copy skill prompt"}</span>
            </button>
          </div>
          <pre className="mcp-config mcp-config-prompt"><code>{skillInstallPrompt}</code></pre>
          <p className="mcp-cli-note">
            Best for AI tools that cannot complete OAuth in a browser (for example DeepSeek
            Harness): the CLI owns the OAuth session and refreshes tokens itself, and also
            exposes the same tools over stdio MCP via <code>unicas mcp</code>. The shipped
            <code> unicas-cli </code> skill tells agents when and how to use the CLI; paste the
            prompt above into tools that cannot read the repository.
          </p>
        </div>
        <div className="mcp-auth-note">
          <strong>No API key required</strong>
          <p>On first use, your AI tool opens a browser and asks you to approve UniCAS access.</p>
        </div>
      </div>
    </div>
  );
}