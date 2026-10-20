import { clientBundle } from "./bundle";

let script: Promise<string> | null = null;

export const webScript = (): Promise<string> => (script ??= clientBundle());
