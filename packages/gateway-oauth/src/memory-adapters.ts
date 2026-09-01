import type {
  GatewayOAuthAuthorizationCodeStorePort,
  GatewayOAuthAuthorizationTransaction,
  GatewayOAuthAuthorizationTransactionStorePort,
  GatewayOAuthClientStorePort,
  GatewayOAuthRefreshRotationResult,
  GatewayOAuthRefreshTokenStorePort,
  GatewayOAuthRegisteredClient,
  GatewayOAuthStoredAuthorizationCode,
  GatewayOAuthStoredRefreshToken,
  GatewayOAuthTenantMembership,
  GatewayOAuthTenantMembershipPort,
} from "./ports.js";

/** Reference adapters for conformance tests and single-process development only. */
export class MemoryGatewayOAuthClientStore implements GatewayOAuthClientStorePort {
  readonly #clients = new Map<string, GatewayOAuthRegisteredClient>();

  async find(clientId: string): Promise<GatewayOAuthRegisteredClient | null> {
    return this.#clients.get(clientId) ?? null;
  }

  async putIfAbsent(client: GatewayOAuthRegisteredClient): Promise<boolean> {
    if (this.#clients.has(client.clientId)) return false;
    this.#clients.set(client.clientId, client);
    return true;
  }
}

export class MemoryGatewayOAuthAuthorizationTransactionStore
  implements GatewayOAuthAuthorizationTransactionStorePort {
  readonly #transactions = new Map<string, GatewayOAuthAuthorizationTransaction>();

  async putIfAbsent(transaction: GatewayOAuthAuthorizationTransaction): Promise<boolean> {
    if (this.#transactions.has(transaction.transactionId)) return false;
    this.#transactions.set(transaction.transactionId, transaction);
    return true;
  }

  async take(transactionId: string): Promise<GatewayOAuthAuthorizationTransaction | null> {
    const transaction = this.#transactions.get(transactionId) ?? null;
    this.#transactions.delete(transactionId);
    return transaction;
  }
}

export class MemoryGatewayOAuthAuthorizationCodeStore
  implements GatewayOAuthAuthorizationCodeStorePort {
  readonly #codes = new Map<string, GatewayOAuthStoredAuthorizationCode>();

  async putIfAbsent(code: GatewayOAuthStoredAuthorizationCode): Promise<boolean> {
    if (this.#codes.has(code.codeHash)) return false;
    this.#codes.set(code.codeHash, code);
    return true;
  }

  async take(codeHash: string): Promise<GatewayOAuthStoredAuthorizationCode | null> {
    const code = this.#codes.get(codeHash) ?? null;
    this.#codes.delete(codeHash);
    return code;
  }
}

export class MemoryGatewayOAuthRefreshTokenStore implements GatewayOAuthRefreshTokenStorePort {
  readonly #active = new Map<string, GatewayOAuthStoredRefreshToken>();
  readonly #used = new Map<string, { readonly familyId: string; readonly clientId: string }>();
  readonly #revokedFamilies = new Set<string>();

  async putInitial(token: GatewayOAuthStoredRefreshToken): Promise<boolean> {
    if (this.#active.has(token.tokenHash) || this.#used.has(token.tokenHash)
      || this.#revokedFamilies.has(token.familyId)) return false;
    this.#active.set(token.tokenHash, token);
    return true;
  }

  async rotate(input: {
    readonly currentHash: string;
    readonly nextHash: string;
    readonly now: number;
  }): Promise<GatewayOAuthRefreshRotationResult> {
    const current = this.#active.get(input.currentHash);
    if (!current) {
      const used = this.#used.get(input.currentHash);
      if (!used) return { status: "invalid" };
      this.#revokeFamily(used.familyId);
      return { status: "replayed" };
    }
    if (current.expiresAt <= input.now || this.#revokedFamilies.has(current.familyId)
      || this.#active.has(input.nextHash) || this.#used.has(input.nextHash)) {
      this.#active.delete(input.currentHash);
      return { status: "invalid" };
    }
    this.#active.delete(input.currentHash);
    this.#used.set(input.currentHash, {
      familyId: current.familyId,
      clientId: current.clientId,
    });
    const successor = Object.freeze({
      ...current,
      tokenHash: input.nextHash,
      generation: current.generation + 1,
      createdAt: input.now,
    });
    this.#active.set(input.nextHash, successor);
    return { status: "rotated", token: successor };
  }

  async revoke(tokenHash: string, clientId: string): Promise<void> {
    const active = this.#active.get(tokenHash);
    if (active?.clientId === clientId) {
      this.#revokeFamily(active.familyId);
      return;
    }
    const used = this.#used.get(tokenHash);
    if (used?.clientId === clientId) this.#revokeFamily(used.familyId);
  }

  #revokeFamily(familyId: string): void {
    this.#revokedFamilies.add(familyId);
    for (const [hash, token] of this.#active) {
      if (token.familyId === familyId) this.#active.delete(hash);
    }
  }
}

export class MemoryGatewayOAuthTenantMembershipStore
  implements GatewayOAuthTenantMembershipPort {
  readonly #memberships = new Map<string, GatewayOAuthTenantMembership>();

  constructor(entries: readonly {
    readonly principalId: string;
    readonly membership: GatewayOAuthTenantMembership;
  }[] = []) {
    for (const entry of entries) this.set(entry.principalId, entry.membership);
  }

  set(principalId: string, membership: GatewayOAuthTenantMembership): void {
    if (principalId.length === 0 || membership.tenantId.length === 0) {
      throw new TypeError("OAuth membership principal and tenant IDs must not be empty");
    }
    this.#memberships.set(key(principalId, membership.tenantId), membership);
  }

  async find(principalId: string, tenantId: string): Promise<GatewayOAuthTenantMembership | null> {
    return this.#memberships.get(key(principalId, tenantId)) ?? null;
  }

  async defaultForPrincipal(principalId: string): Promise<GatewayOAuthTenantMembership | null> {
    for (const [k, membership] of this.#memberships) {
      if (k.startsWith(`${principalId.length}:${principalId}`)) return membership;
    }
    return null;
  }
}

function key(principalId: string, tenantId: string): string {
  return `${principalId.length}:${principalId}${tenantId}`;
}
