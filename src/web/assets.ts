import { join } from "node:path";
import { clientBundle } from "./bundle";

export const LOGO_PATH = join(import.meta.dir, "..", "..", "site", "public", "logo-512.png");

let script: Promise<string> | null = null;

export const webScript = (): Promise<string> => (script ??= clientBundle());

export const logoPng = async (): Promise<Uint8Array> => Bun.file(LOGO_PATH).bytes();
