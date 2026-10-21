import { z } from "zod";
import type { HubConfig } from "../../config";
import { TapsterError } from "../../errors";
import { hubEnv } from "../../cli/gh";
import { linuxChoices, linuxKeyAllowed, makeLinuxKey, withLinux } from "../../cli/linuxkey";
import type { LinuxView } from "../contract";
import { type Ctx, type Routes, type Session, readJson } from "../server";
import { hubFrom, lockedEnvironment, writeMain } from "./access";

export async function linuxView(s: Session, hub: string, text: string | null, config: HubConfig | null, secrets: string[]): Promise<LinuxView> {
  let tools: LinuxView["tools"] = [];
  try {
    tools = text === null ? [] : linuxChoices(text, hub.split("/")[0]!);
  } catch {
    tools = [];
  }
  const store = s.deps.store();
  return {
    wanted: tools.some((t) => t.on),
    stored: secrets.includes("TAPSTER_LINUX_KEY"),
    gpg: (await s.deps.gpg()) !== null,
    keystore: store ? (store.kind === "keychain" ? "keychain" : "keyring") : null,
    maintainer: config?.linux?.maintainer ?? null,
    tools,
  };
}

async function key(c: Ctx) {
  const { hub } = await readJson(c.req, z.object({ hub: z.string() }).strict());
  const { gh } = await hubFrom(c, hub);
  await lockedEnvironment(gh, hub);
  linuxKeyAllowed((await hubEnv(gh, hub, "secrets")).map((x) => x.name), false);
  const store = c.s.deps.store();
  if (!store) throw new TapsterError("this computer has no keychain tapster can use", "Run tapster setup on macOS or on Linux with secret-tool (libsecret-tools) installed. The key must never live only in GitHub, which never gives secrets back.");
  const gpg = await c.s.deps.gpg();
  if (!gpg) throw new TapsterError("GnuPG is not installed", "Install it with brew install gnupg, then try again.");
  const made = await makeLinuxKey(gh, hub, { gpg, store, rotate: false });
  return { fingerprint: made.fingerprint, keychain: store.kind === "keychain" };
}

const tool = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(100), was: z.boolean(), on: z.boolean() }).strict();
const configBody = z.object({ hub: z.string(), maintainer: z.string().trim().max(200), tools: z.array(tool).max(200) }).strict();

async function config(c: Ctx) {
  const body = await readJson(c.req, configBody);
  const { gh, hub, login } = await hubFrom(c, body.hub);
  const result = await writeMain(gh, hub, login, async (_, read) => {
    const text = await read("tapster.yml");
    if (text === null) throw new TapsterError(`${hub} has no tapster.yml yet`, "Write the hub files first.");
    const next = withLinux(text, hub.split("/")[0]!, body.maintainer, body.tools);
    return { message: "Ship command line tools to apt and dnf", files: next === text ? [] : [{ path: "tapster.yml", content: next }] };
  });
  return { result };
}

export const linuxRoutes: Routes = {
  "POST /api/hub/linux/key": key,
  "POST /api/hub/linux/config": config,
};
