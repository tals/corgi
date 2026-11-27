import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { str } from "../common";

export function home(env = process.env) {
  if (!env.HOME) throw Error("NoHome");
  return env.HOME;
}
export const directory = (account = "") => join(account || home(), ".gemini", "antigravity-cli");
export const customizations = (account = "") => join(account || home(), ".gemini", "config");
export const validSession = (id: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);

export async function read(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}
export async function identity(account: string) {
  const login = await read(join(directory(account), "antigravity-oauth-token")),
    email = str(login, "id_token_email");
  return email ? { id: email, email } : null;
}
