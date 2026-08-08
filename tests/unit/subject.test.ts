import { describe, expect, it } from "vitest";

import { subjectOf } from "../../src/transport/streamableHttp.js";

// Session subject-binding: a live MCP HTTP session is bound to subjectOf(token).
// A request whose bearer resolves to a different subject is never bound to that
// session (hijack / cross-principal token swap). These pin the binding key.
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

describe("subjectOf", () => {
  it("binds an OAuth JWT to sub+org_id, stable across token refresh", () => {
    const a = jwt({ sub: "user-123", org_id: "org-a", exp: 1 });
    const b = jwt({ sub: "user-123", org_id: "org-a", exp: 2 }); // refreshed token
    expect(subjectOf(a)).toBe("jwt:user-123:org-a");
    expect(subjectOf(a)).toBe(subjectOf(b));
  });

  it("separates the SAME user acting in DIFFERENT orgs (no cross-org session swap)", () => {
    const orgA = jwt({ sub: "user-123", org_id: "org-a" });
    const orgB = jwt({ sub: "user-123", org_id: "org-b" });
    expect(subjectOf(orgA)).not.toBe(subjectOf(orgB));
  });

  it("separates distinct OAuth subjects", () => {
    expect(subjectOf(jwt({ sub: "user-1" }))).not.toBe(
      subjectOf(jwt({ sub: "user-2" })),
    );
  });

  it("falls back to sub alone for a JWT without org_id (still refresh-stable)", () => {
    expect(subjectOf(jwt({ sub: "user-9", exp: 1 }))).toBe("jwt:user-9");
    expect(subjectOf(jwt({ sub: "user-9", exp: 1 }))).toBe(
      subjectOf(jwt({ sub: "user-9", exp: 2 })),
    );
  });

  it("binds an opaque PAT to a hash of the token", () => {
    const s = subjectOf("lune_abc123");
    expect(s.startsWith("pat:")).toBe(true);
    expect(subjectOf("lune_abc123")).toBe(s); // deterministic
    expect(subjectOf("lune_different")).not.toBe(s);
  });

  it("falls back to the PAT hash for an undecodable/sub-less token", () => {
    expect(subjectOf("not.a.jwt-without-valid-base64-or-sub")).toMatch(/^pat:/);
    expect(subjectOf(jwt({ no_sub: true }))).toMatch(/^pat:/);
  });
});
