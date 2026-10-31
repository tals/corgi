# Paused JSON parse idea

Source-only hypothesis; no implementation, tests or timing. Paused to keep the
active queue on V18 validation and the paced transport gate.

`src/json.ts` currently uses a reviver on every value solely to preserve unsafe
integer tokens as BigInt. A possible compact benchmark alternative is ordinary
`JSON.parse`, then one lexical scan whose alternatives consume complete quoted
strings or numeric tokens. Map each non-safe Number to the result the existing
reviver would produce: BigInt for integer spelling, Number for decimal/exponent
spelling. If any two tokens with the same rounded Number require different
results or types, fall back to the original parser. Otherwise walk the parsed
tree only if there is a BigInt replacement; duplicate keys and key enumeration
order need no token-to-property correspondence.

Prospective correctness cases include escaped quotes/backslashes and numeric
text inside strings; integer/float rounding collisions; overflowing integer
versus exponent tokens; duplicate keys; numeric key ordering; negative zero;
root numbers; arrays; own `__proto__` data properties; and malformed JSON.
Ordinary parse must validate before the lexical scan. A future prototype must
also decide whether pathological recursion-limit failures count as exact
behavior: the current reviver traverses even a document with no wide integers,
while a fast path would skip that traversal.

Any later performance gate should use the existing actual canonical View
corpus, including quoted stamps and a separate wide-integer envelope. Native
capture and corpus generation stay outside timing. Report parse CPU and input
bytes, not an inferred whole-viewer saving from the profile sample fraction.
