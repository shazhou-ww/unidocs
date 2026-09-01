import { describe, expect, test } from "vitest";
import {
  casAdminRoutes,
  matchCasAdminRoute,
} from "../src/index.js";

describe("CAS admin routes", () => {
  test.each([
    ["GET", casAdminRoutes.me(), "me"],
    ["GET", casAdminRoutes.stacks(), "listStacks"],
    ["POST", casAdminRoutes.stacks(), "createStack"],
    ["GET", casAdminRoutes.stack({ stackId: "stack/a" }), "getStack"],
    ["PATCH", casAdminRoutes.stack({ stackId: "stack/a" }), "patchStack"],
    ["GET", casAdminRoutes.members({ stackId: "stack/a" }), "listMembers"],
    ["DELETE", casAdminRoutes.members({ stackId: "stack/a" }), "deleteMember"],
    ["POST", casAdminRoutes.memberInvitations({ stackId: "stack/a" }), "createMemberInvitation"],
    ["POST", casAdminRoutes.acceptMemberInvitation({ token: "tok/1" }), "acceptMemberInvitation"],
    ["GET", casAdminRoutes.issuer({ stackId: "stack/a" }), "getIssuer"],
    ["GET", casAdminRoutes.oauthIssuer({ stackId: "stack/a" }), "getOAuthIssuer"],
    ["POST", casAdminRoutes.oauthIssuerInspections({ stackId: "stack/a" }), "inspectOAuthIssuer"],
    ["PUT", casAdminRoutes.issuer({ stackId: "stack/a" }), "putIssuer"],
    ["GET", casAdminRoutes.issuerKeys({ stackId: "stack/a" }), "listIssuerKeys"],
    ["POST", casAdminRoutes.issuerKeys({ stackId: "stack/a" }), "createIssuerKey"],
    ["DELETE", casAdminRoutes.issuerKey({ stackId: "stack/a", kid: "k/1" }), "deleteIssuerKey"],
    ["GET", casAdminRoutes.refDomains({ stackId: "stack/a" }), "listRefDomains"],
    ["GET", casAdminRoutes.controlAuditEvents({ stackId: "stack/a" }), "listControlAuditEvents"],
    ["GET", casAdminRoutes.rootDomainRefs({ stackId: "stack/a", refDomain: "doc" }), "listRootDomainRefs"],
    ["GET", casAdminRoutes.rootDomainEvents({ stackId: "stack/a", refDomain: "doc" }), "listRootDomainEvents"],
  ] as const)("matches %s %s -> %s", (method, pathname, operation) => {
    expect(matchCasAdminRoute(method, pathname)).toMatchObject({ operation });
  });

  test("encodes path segments", () => {
    expect(casAdminRoutes.stack({ stackId: "stack/a" })).toBe("/admin/stacks/stack%2Fa");
    expect(casAdminRoutes.rootDomainRefs({ stackId: "s", refDomain: "doc:md" }))
      .toBe("/admin/stacks/s/root-ref-domains/doc%3Amd/refs");
  });

  test("rejects tenant paths and wrong methods", () => {
    expect(matchCasAdminRoute("GET", "/stacks/s/tenants/t/usage")).toBeNull();
    expect(matchCasAdminRoute("GET", "/tenants/t/cas/usage")).toBeNull();
    expect(matchCasAdminRoute("POST", casAdminRoutes.me())).toBeNull();
    expect(matchCasAdminRoute("POST", casAdminRoutes.refDomains({ stackId: "s" }))).toBeNull();
    expect(matchCasAdminRoute("PUT", casAdminRoutes.oauthIssuer({ stackId: "s" }))).toBeNull();
    expect(matchCasAdminRoute("GET", casAdminRoutes.oauthIssuerInspections({ stackId: "s" }))).toBeNull();
    expect(matchCasAdminRoute("GET", "/admin/%ZZ/stacks")).toBeNull();
  });

  test("never emits tenant operation names", () => {
    const route = matchCasAdminRoute(
      "GET",
      casAdminRoutes.rootDomainRefs({ stackId: "s", refDomain: "doc" }),
    );
    expect(route?.operation).toBe("listRootDomainRefs");
    expect(JSON.stringify(route)).not.toMatch(/updateRootRefs|readContent|rootRefs/);
  });
});
