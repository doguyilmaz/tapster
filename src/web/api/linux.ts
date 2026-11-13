import { z } from "zod";
import type { HubConfig } from "../../config";
import { TapsterError } from "../../errors";
import { hubEnv } from "../../cli/gh";
import { readHubFile } from "../../hubcommit";
import { finishLinuxRotation, linuxChoices, linuxKeyAllowed, linuxLeft, makeLinuxKey, withLinux } from "../../cli/linuxkey";
import type { LinuxChange, LinuxView } from "../contract";
import { type Ctx, type Routes, type Session, readJson } from "../server";
import { hubFrom, keyOperation, lockedEnvironment, writeMain } from "./access";

export async function linuxView(s: Session, hub: string, text: string | null, config: HubConfig | null, secrets: string[]): Promise<LinuxView> {
  let tools: LinuxView["tools"] = [];
  let left: LinuxView["left"] = [];
  try {
    tools = text === null ? [] : linuxChoices(text, hub.split("/")[0]!);
    left = text === null ? [] : linuxLeft(text, hub.split("/")[0]!);
  } catch {
    tools = [];
    left = [];
  }
  const store = s.deps.store();
  return {
    wanted: tools.some((t) => t.on),
    stored: secrets.includes("TAPSTER_LINUX_KEY"),
    previous: secrets.includes("TAPSTER_LINUX_KEY_PREVIOUS"),
    gpg: (await s.deps.gpg()) !== null,
    keystore: store ? (store.kind === "keychain" ? "keychain" : "keyring") : null,
    maintainer: config?.linux?.maintainer ?? null,
    tools,
    left,
  };
}

async function key(c: Ctx) {
  const { hub, rotate = false } = await readJson(c.req, z.object({ hub: z.string(), rotate: z.boolean().optional() }).strict());
  const { gh } = await hubFrom(c, hub);
  return keyOperation(c.s, hub, async () => {
    await lockedEnvironment(gh, hub);
    const secrets = (await hubEnv(gh, hub, "secrets")).map((x) => x.name);
    linuxKeyAllowed(secrets, rotate);
    if (rotate && secrets.includes("TAPSTER_LINUX_KEY_PREVIOUS")) throw new TapsterError("a Linux key rotation is still in progress", "Finish the current rotation after users have moved to the new key, before rotating again.");
    const store = c.s.deps.store();
    if (!store) throw new TapsterError("this computer has no keychain tapster can use", "Run tapster setup on macOS or on Linux with secret-tool (libsecret-tools) installed. The key must never live only in GitHub, which never gives secrets back.");
    const gpg = await c.s.deps.gpg();
    if (!gpg) throw new TapsterError("GnuPG is not installed", "Install it with brew install gnupg, then try again.");
    const made = await makeLinuxKey(gh, hub, { gpg, store, rotate });
    return { fingerprint: made.fingerprint, keychain: store.kind === "keychain", previous: made.previous };
  });
}

async function finish(c: Ctx) {
  const { hub } = await readJson(c.req, z.object({ hub: z.string() }).strict());
  const { gh } = await hubFrom(c, hub);
  return keyOperation(c.s, hub, async () => {
    await lockedEnvironment(gh, hub);
    return { removed: await finishLinuxRotation(gh, hub, c.s.deps.store()) };
  });
}

const tool = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(100), was: z.boolean(), on: z.boolean() }).strict();
const configBody = z.object({ hub: z.string(), maintainer: z.string().trim().max(200), tools: z.array(tool).max(200) }).strict();

const linuxChange = async (hub: string, body: z.infer<typeof configBody>, read: (path: string) => Promise<string | null>): Promise<LinuxChange> => {
  const text = await read("tapster.yml");
  if (text === null) throw new TapsterError(`${hub} has no tapster.yml yet`, "Write the hub files first.");
  return { before: text, after: withLinux(text, hub.split("/")[0]!, body.maintainer, body.tools) };
};

async function preview(c: Ctx): Promise<LinuxChange> {
  const body = await readJson(c.req, configBody);
  const { gh, hub } = await hubFrom(c, body.hub);
  return linuxChange(hub, body, (p) => readHubFile(gh, hub, p, "main"));
}

async function config(c: Ctx) {
  const body = await readJson(c.req, configBody);
  const { gh, hub, login } = await hubFrom(c, body.hub);
  const result = await writeMain(gh, hub, login, async (_, read) => {
    const { before, after } = await linuxChange(hub, body, read);
    return { message: "Ship command line tools to apt and dnf", files: after === before ? [] : [{ path: "tapster.yml", content: after }] };
  });
  return { result };
}

export const linuxRoutes: Routes = {
  "POST /api/hub/linux/key": key,
  "POST /api/hub/linux/finish": finish,
  "POST /api/hub/linux/preview": preview,
  "POST /api/hub/linux/config": config,
};
