import { afterEach, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { appJwt, installationExists, installationToken } from "../src/token";
import { resetMaskForTests, scrub } from "../src/mask";

afterEach(resetMaskForTests);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

test("the JWT is RS256, short-lived and masked", () => {
  const now = Date.UTC(2026, 9, 18, 12, 0, 0);
  const jwt = appJwt("12345", pem, now);
  const [h, p, s] = jwt.split(".");
  expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
  expect(payload.iss).toBe("12345");
  expect(payload.exp - payload.iat).toBe(540);
  expect(scrub(jwt)).toBe("***");
});

test("installation tokens are scoped, masked and revocable", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/repos/o/aims/installation")) return Response.json({ id: 77 });
    if (url.endsWith("/app/installations/77/access_tokens")) return Response.json({ token: "ghs_installationtoken" }, { status: 201 });
    if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  };
  const tok = await installationToken("12345", pem, "o/aims", { contents: "write" }, fetchImpl);
  expect(tok.token).toBe("ghs_installationtoken");
  expect(scrub("x ghs_installationtoken")).toBe("x ***");
  const body = JSON.parse(calls[1]!.init!.body as string);
  expect(body).toEqual({ repositories: ["aims"], permissions: { contents: "write" } });
  await tok.revoke();
  expect(calls.at(-1)!.init!.method).toBe("DELETE");
});

test("installationExists asks GitHub with the App JWT", async () => {
  const seen: string[] = [];
  const reply = (status: number) => async (url: string, init?: RequestInit) => {
    seen.push(`${url} ${(init?.headers as Record<string, string>).Authorization?.split(".").length}`);
    return new Response(status === 200 ? "{}" : null, { status });
  };
  expect(await installationExists("1", pem, "o/hub", reply(200))).toBe(true);
  expect(await installationExists("1", pem, "o/hub", reply(404))).toBe(false);
  expect(seen[0]).toBe("https://api.github.com/repos/o/hub/installation 3");
});
