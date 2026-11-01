# Translations

English lives at the call site. `zh.json` (Simplified Chinese), `ja.json`,
`ko.json`, and `ru.json` contain the translations, including the installer.
There are no explicit message IDs or runtime dependencies.

```ts
import * as i18n from "./i18n";

const name = workspace.name;
const message = i18n.t`Close ${name}?`;
```

A catalog entry looks like this:

```json
{
  "Close ${name}?": "关闭${name}？"
}
```

Placeholders must be named local variables. Give an expression a local name
before using it in a tag. Translations can reorder or repeat placeholders;
they must retain the same set of names. Identical English template shapes
must use the same names everywhere. Literal `${` is reserved for placeholders.
Keep complete sentences together. Evaluate tags when drawing or handling an
action, rather than in module-level tables, so changing language takes effect.

For plurals, a language can replace a string with an object:

```json
{
  "${count} files": {
    "plural": "count",
    "forms": {
      "one": "${count} файл",
      "few": "${count} файла",
      "many": "${count} файлов",
      "other": "${count} файла"
    }
  }
}
```

Categories come from `Intl.PluralRules` for that language. All required
categories must be present. Installer messages use strings only.

## Updating messages

1. Add or change the English tag. For imported help text use
   `i18n.document(textAsset)`. In `scripts/install.sh.in`, use
   `msg 'Installing ${version}…' "$VERSION"`; arguments follow the English
   placeholder order. Installer source messages use single-quoted literals.
2. Run `bun scripts/translations.ts extract`. This adds blank entries and
   removes unused ones. `.tools/i18n/messages.json` lists source locations.
3. Translate the new entries in every language, preserving commands, flags,
   keyboard chords and placeholders. English text changes intentionally
   require new translations.
4. Run `bun scripts/translations.ts generate` and commit both generated files:
   `src/i18n.generated.ts` and `scripts/install_i18n.generated.sh`.

`bun scripts/translations.ts check` fails on missing, blank, unused or stale
translations, invalid placeholders or plural categories, and stale generated
files. Build and typecheck run it, so CI checks the same contract. It also
rejects direct unmarked literals in selected UI sinks; arbitrary unmarked
strings still need code review. Nonempty untranslated English cannot be
identified reliably by a mechanical check (product names and commands often
must remain English).

The compiler reads the TypeScript AST to recover placeholder names and emits
ordinary JavaScript template functions. The runtime tag selects a function
from its template's fixed strings and passes the evaluated values. Generated
shell code uses quoted `printf '%s'` arguments; neither runtime evaluates
translation text as code. Committed output means ordinary `bun` runs need no
preprocessing pass. Generation runs only when messages or translations change.

## Language selection

Selection order is `CORGI_LANG`, the saved language in Corgi setup, then the
host locale. `CORGI_LANG=auto` leaves automatic selection enabled. Host
selection uses `LANGUAGE` preferences and the effective message locale
(`LC_ALL`, then `LC_MESSAGES`, then `LANG`). `C` and `POSIX` explicitly select
English, including `C.UTF-8`. With no message locale, macOS uses the user's
AppleLanguages list. `LC_CTYPE` alone does not select a UI language.

Language and region spellings such as `ja_JP.UTF-8`, `ko-KR`, and `ru_RU`
are accepted. All Chinese variants currently select Simplified Chinese.
Unsupported locales fall back to English. The installer uses the same host
rules and leaves the language environment unchanged, so Corgi can apply a
saved preference or let the user choose one during setup. The installer
cannot read a saved UI preference before installation. A saved preference
is an optional viewer setting; protocol and checkpoint schemas are unchanged.

Translate app chrome, not terminal programs, provider messages, generated
summaries, user names, paths or command syntax. Machine-oriented CLI output
keeps its existing format. Measure and clip UI text with `text.displayWidth`,
`text.clipped`, and `text.wrap`, not JavaScript string length.
`text.truncatedText` limits UTF-8 bytes rather than terminal cells; use it for
byte budgets, not visual clipping.

`bun tools/i18n_screenshots.ts` captures the main screens in every language
through live Ghostty at wide and narrow sizes. See the
[screenshot gallery](../docs/images/localization/README.md) for examples and setup.
