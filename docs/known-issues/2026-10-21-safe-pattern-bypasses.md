# The safe-pattern check could be bypassed, and builder errors could land on the wrong field

Resolved before merge, GWP#4. Found by four fresh-context whole-branch reviews.

## Safe-pattern bypasses

A capture field's `pattern` runs in the API on every submitted item, so `packages/contracts/src/safe-pattern.ts` refuses, at definition time, patterns that can backtrack long enough to hang the event loop ([capture.md](../capture.md)). Two shapes passed it:

- **`[]` and `[^]` read as the start of a longer class.** The scanner treated a `]` right after `[` or `[^` as a literal, as POSIX and PCRE do. In JavaScript `[]` and `[^]` are complete classes, so in `[^](a+)+b]` the nested repeat `(a+)+` was hidden inside what the scanner took for one class. That pattern took 22 s on a 31-character value.
- **Unrepeated alternations multiply.** Alternation was refused only inside a repeated group, and only variable repeats were counted. `(a|a)` repeated 40 times (200 characters) backtracks 2^40 ways, and `(a|a)` eight times followed by `a*a*a*` took 6.7 s on 256 characters, though each part alone is fast.

The first fix closed the class correctly and bounded the estimated ways to match at 2^22. The second review then found a third shape: fixed-count repeats after variable ones, such as `\d*\d*\d*\d{60}` (2 s on 256 characters) and `(a|a)` 22 times followed by `a{234}` (25 s). V8 runs a `{n}` loop again on every backtrack, so the work per path, which the estimate did not count, was unbounded.

Fix: patterns are no longer run with `RegExp`. `packages/contracts/src/pattern-matcher.ts` matches them with a Thompson NFA in time linear in the value's length (at most 5,000 states per pattern, 20,000 per definition), so no pattern can hang the API. The safe-pattern check stays as definition-time policy, with the class and alternation fixes. A `]` right after `[` or `[^` closes the class. `buildCaptureSchema` never runs a stored pattern that fails the checks; the field is refused instead.

Regression tests:

- `packages/contracts/test/pattern-matcher.test.ts`: "compilePattern: linear time" (every pattern from both reviews, under 100 ms on its worst input) and "agrees with RegExp on supported patterns".
- `packages/contracts/test/capture.test.ts`: "refuses `[^](a+)+b]`" and the other cases in that list; "the worst patterns it accepts finish quickly on their worst input of the longest length a patterned field takes"; "a stored pattern that fails the check is never run: the field is refused instead".

A third review found the compiler, not the matcher, could still be made slow: nested groups such as `((((a)))){4990}` cost compile work per copy without adding states (26 ms per pattern), and a definition parse compiled every pattern several times, so a 100 kB definition of 408 such fields took 14 s to be refused. Fix: a group's single item is the item itself (nesting costs nothing), definition-time checks count states from the parse tree (`analysePattern`, linear in the pattern's length) and never build an NFA, and validation builds only the patterns the definition's 20,000-state budget allows. That definition is now refused in about 40 ms.

Regression tests: `packages/contracts/test/pattern-matcher.test.ts`, "compiles a deeply nested pattern without walking the nesting once per copy" and "counts the states ... compiles to, without building them"; `packages/contracts/test/capture.test.ts`, "a definition as large as the API accepts (100 kB) is checked quickly, however its patterns nest".

A fourth review found the matcher's step cost was not constant: a class was one state but tested each of its members in turn, so 77 fields of `.*[\s\s…(94)…\d]{256}`, within the state budget, took 2.1 s to validate one 21 kB item. Fix: every class is normalised when parsed to sorted, merged code-unit ranges (with `\d`, `\w`, `\s` and their negations expanded) and tested by binary search. The same item now validates in about 110 ms.

Regression test: `packages/contracts/test/capture.test.ts`, "an item of patterned fields with long classes validates quickly" (repeated class escapes, and many ranges).

## Builder errors on the wrong field

The API keys a refused definition's errors by field position (`definition.fields.2.pattern`). The builder cleared them when a field's settings changed but not when a field was moved, removed or added, so after a reorder a server message showed on a different field.

Fix: every builder edit clears the server's errors (`apps/web/src/work-types/builder/Builder.tsx`, `edit`). The builder's own check runs again on every render, so its errors follow the fields.

Regression test: `apps/web/src/work-types/builder/Builder.test.tsx` (unit, jsdom; GWP#59), "shows a refused save's error beside the field it names, and on no field once a field moves": a stubbed 422 names `definition.fields.1.pattern`, and after Move up no field shows it. It fails with the clearing in `edit` removed. Its companion, "keeps the builder's own pattern error beside its field after the field moves", covers the builder's own check.
