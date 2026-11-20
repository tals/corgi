//! Codex's own first-run sign-in, read off its screen so `corgi account add`
//! can frame it. It asks how to sign in, then shows a link whose page
//! reports back to this machine, or a link and a one-time code.
import type { Signin } from "../adapter";
import { identity } from "./info";

/** The step a screen of its sign-in shows. */
function step(text: string) {
  // Its device-code screen also says to finish in the browser.
  if (text.includes("Enter this one-time code")) return "device";
  if (text.includes("Sign in with Device Code") && text.includes("Sign in with ChatGPT")) return "method";
  if (text.includes("Finish signing in via your browser") || text.includes("navigate to this URL to authenticate"))
    return "browser";
  return null;
}
export const signin: Signin = {
  // It's up once it asks how to sign in, or fails.
  started: text => step(text) !== null || /\bError\b/.test(text),
  step,
  hints: {
    method: "Signing in from another computer? Pick Sign in with Device Code.",
    browser:
      "Sign in as the account you're adding. The page reports back to this computer: from another one, press Esc and pick Device Code.",
    device: "Open the link on any device, sign in as the account you're adding, and enter the code.",
  },
  ready: async root => (await identity(root)) !== null,
  check: ["login", "status"],
  logout: ["logout"],
  // Without its server it asks how to sign in sooner: a first start would
  // copy the server into the folder and wait on it.
  first: ["--no-daemon"],
  // Its app doesn't offer to sign in where it has sessions. A code works
  // from any machine, over SSH too, where its browser sign-in can't.
  again: ["login", "--device-auth"],
};
