/** Marked HTML shares the application's catalog and preserves its inline elements. */
import { join } from "node:path";
import * as tooling from "./tooling";

export async function transform(html: string, translate: (source: string, markup: boolean) => string): Promise<string> {
  const dom = await tooling.dependency("happy-dom");
  const { Window } = await import(join(dom, "lib/index.js"));
  const window = new Window({ settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  try {
    window.document.write(html);
    for (const element of window.document.querySelectorAll("[data-i18n]")) {
      if (element.querySelector("[data-i18n]")) throw Error("Nested data-i18n elements");
      element.innerHTML = translate(element.innerHTML.trim(), true);
    }
    for (const element of window.document.querySelectorAll("[data-i18n-attrs]")) {
      for (const name of element.getAttribute("data-i18n-attrs").split(" ")) {
        const source = element.getAttribute(name);
        if (source) element.setAttribute(name, translate(source, false));
      }
    }
    return "<!doctype html>\n" + window.document.documentElement.outerHTML;
  } finally {
    await window.happyDOM.close();
  }
}
