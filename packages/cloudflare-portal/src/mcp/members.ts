import type { D1Database } from "@cloudflare/workers-types";
import type { AdminIdentity, AdminMcpMember } from "@unidocs/portal-service";

interface MemberRow {
  memberId: string;
  issuer: string;
  subject: string;
  email: string;
}

export class D1AdminMcpMembers {
  constructor(private readonly database: D1Database) {}

  async findById(memberId: string): Promise<AdminMcpMember | null> {
    const row = await this.database.prepare(`SELECT member_id AS memberId, issuer, subject, email
      FROM portal_administrators WHERE member_id = ? AND active = 1 AND issuer IS NOT NULL AND subject IS NOT NULL`)
      .bind(memberId).first<MemberRow>();
    return row ? { ...row, active: true } : null;
  }

  async findByIdentity(identity: Pick<AdminIdentity, "issuer" | "subject">): Promise<AdminMcpMember | null> {
    const row = await this.database.prepare(`SELECT member_id AS memberId, issuer, subject, email
      FROM portal_administrators WHERE issuer = ? AND subject = ? AND active = 1`)
      .bind(identity.issuer, identity.subject).first<MemberRow>();
    return row ? { ...row, active: true } : null;
  }
}