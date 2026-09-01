import { useCallback, useEffect, useState } from "react";
import { UserMinus, UserPlus } from "lucide-react";
import type { CasStackMember } from "@unicas/admin-client";
import { api, ifMatch } from "../api.js";
import { Button, Card, EmptyState, ErrorState, LoadingState, Table } from "../components.js";
import { formatErrorSafe } from "./view-helpers.js";

interface InvitationResult {
  readonly invitation: { invitationId: string; expiresAt: number };
  readonly acceptUrl: string;
}

export function MembersView({ stackId, stackRevision, onChanged }: {
  stackId: string;
  stackRevision: number;
  onChanged: () => void;
}) {
  const [members, setMembers] = useState<CasStackMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<InvitationResult | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api<{ items: CasStackMember[] }>(`/admin/stacks/${encodeURIComponent(stackId)}/members`);
      setMembers(result.items);
    } catch (caught) {
      setError(formatErrorSafe(caught));
    }
  }, [stackId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function invite() {
    setInviting(true);
    setError(null);
    setInviteResult(null);
    try {
      const result = await api<InvitationResult>(
        `/admin/stacks/${encodeURIComponent(stackId)}/member-invitations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(email.trim().length > 0 ? { emailConstraint: email.trim() } : {}),
        },
      );
      setInviteResult(result);
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setInviting(false);
    }
  }

  async function removeMember(identityIssuer: string, subject: string) {
    setRemoving(subject);
    setError(null);
    try {
      await api<{ ok: true }>(
        `/admin/stacks/${encodeURIComponent(stackId)}/members?identityIssuer=${encodeURIComponent(identityIssuer)}&subject=${encodeURIComponent(subject)}`,
        { method: "DELETE", headers: ifMatch(stackRevision) },
      );
      onChanged();
      await load();
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <>
      <Card title="Invite a member">
        <div className="inline-form">
          <input
            aria-label="Email constraint (optional)"
            value={email}
            placeholder="email constraint (optional)"
            onChange={(event) => setEmail(event.target.value)}
          />
          <Button icon={<UserPlus size={15} />} variant="primary" onClick={() => void invite()} disabled={inviting}>
            {inviting ? "Creating…" : "Create invitation"}
          </Button>
        </div>
        {inviteResult ? (
          <div className="invite-result">
            <p>
              One-time invitation created (expires {new Date(inviteResult.invitation.expiresAt).toLocaleString()}).
              Share this URL once:
            </p>
            <code className="accept-url">{inviteResult.acceptUrl}</code>
          </div>
        ) : null}
      </Card>
      <Card title="Members">
        {error ? <ErrorState message={error} /> : null}
        {members === null && !error ? <LoadingState /> : null}
        {members !== null && members.length === 0 ? (
          <EmptyState message="No members." />
        ) : null}
        {members !== null && members.length > 0 ? (
          <Table
            columns={["Subject", "Email", ""]}
            empty="No members."
            rows={members.map((member) => [
              member.subject,
              member.emailForDisplay ?? "—",
              <Button
                key={`remove-${member.subject}`}
                icon={<UserMinus size={15} />}
                variant="danger"
                disabled={removing === member.subject}
                onClick={() => void removeMember(member.identityIssuer, member.subject)}
              >
                {removing === member.subject ? "Removing…" : "Remove"}
              </Button>,
            ])}
          />
        ) : null}
      </Card>
    </>
  );
}
