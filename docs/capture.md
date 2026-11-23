# Capture: the schema builder and validated items

Capture is the first of GetWorkDone's three verbs (GWP#4, spec §4.3). A team admin defines a work type's fields in a structured builder, and members submit items that are validated the same way in the browser and the API: the Zod schema is generated from the definition and no LLM is involved (D-028). Decisions are cited by number from the program register (spec §9.4) and never copied here. The entities themselves are in [domain.md](domain.md).

## One validator, both sides

`packages/contracts/src/capture.ts` is shared by `apps/web` and `apps/api`:

- `buildCaptureSchema(fields)` returns a strict `z.object`: one key per field, optional fields may be left out, any other key is refused.
- `validateCapture(fields, input)` returns `{ ok: true, data }` or `{ ok: false, errors }`, where `errors` is `CaptureErrors`: field key -> messages. An unknown key is reported under its own name (`Unknown field`); an input that is not an object is reported under `_form`.

The browser turns the form's inputs into the item's data with `apps/web/src/work-types/capture/form-values.ts` (empty inputs left out, numbers parsed, anything unparseable kept as typed), validates that object, and sends that same object as the request's `data`. The API validates it again against the work type's latest version, so the messages a person sees before submitting are the ones the API would return (the e2e test `tests/e2e/builder-capture.spec.ts` asserts this).

## Field types and their validation

Every field has a `key` (lower snake case, unique in the definition), a `label` and `required` (default false).

| Type | Value | Settings | Messages |
|---|---|---|---|
| `text` | string | `min`, `max` (length), `pattern` | `Must be text`, `Must be at least N characters`, `Must be at most N characters`, `Does not match the expected format` |
| `longtext` | string (multi-line) | as `text` | as `text` |
| `number` | finite JSON number; a numeric string is not accepted | `min`, `max` (value) | `Must be a number`, `Must be at least N`, `Must be at most N` |
| `date` | ISO 8601 calendar date, `YYYY-MM-DD` | none | `Must be a date (YYYY-MM-DD)` |
| `boolean` | `true` or `false` | none | `Must be true or false` |
| `select` | one of `options` | `options` (at least one, distinct) | `Must be one of: a, b, c` |
| `email` | an email address (Zod's `z.email()`) | none | `Must be an email address` |
| `url` | an `http` or `https` URL (Zod's `z.url()`, other schemes refused) | none | `Must be an http or https URL` |

Presence:

- A required field that is absent is `Required`. A required `text` or `longtext` field that is the empty string is `Required` too.
- An optional field accepts absence, not an empty string: `""` on an optional number is `Must be a number`, on an optional text field `Must not be empty; leave the field out instead`. The capture form leaves empty inputs out, so a person never sees these.
- `null` is a value, not absence, and is refused with the type's message.

## Definition-time checks

`CaptureField` (in `domain.ts`) runs `captureFieldProblems` on every field, so every writer of a definition, the builder's own check, `POST .../work-types` and `POST .../versions`, refuses:

- a `pattern` on a type other than `text` or `longtext`; a pattern over 200 characters; one that does not compile as a JavaScript regular expression; one the safe-pattern check or the linear-time matcher refuses (below);
- `max` over 256 on a field with a pattern (the longest value a patterned field takes);
- patterns that together compile to more than 20,000 matcher states across the definition (so one item's validation stays bounded however many patterned fields there are);
- a `select` without options or with repeated options; `options` on any other type;
- `min` or `max` on a type other than `text`, `longtext` or `number`; a length that is not a whole number 0 or more; `min` greater than `max`.

### Patterns

A pattern is matched against the whole value, as in an HTML `pattern` attribute: `[A-Z]{3}-\d+` accepts `ABC-12`, not `xABC-12`. It is JavaScript regular expression syntax with no flags.

A pattern runs in the API on every submitted item, so it must not be able to hang the server. Two layers, both in `packages/contracts` and so the same in the browser and the API:

- **Matching is linear-time.** Patterns are never run with `RegExp`. `packages/contracts/src/pattern-matcher.ts` compiles a pattern to a Thompson NFA (at most 5,000 states per pattern and 20,000 for all of a definition's patterns together; `{n,m}` copies its operand) and simulates it with state sets, so a match takes at most (value length + 1) x states steps, whatever the pattern. Every character class (and `.`, `\d`, `\w`, `\s` and their negations) is normalised when parsed to sorted, merged ranges of code units and tested by binary search, so a step costs the same however the class is written. Definition-time checks count a pattern's states from its parse tree without building anything, so checking a definition is linear in the length of its patterns. It supports literals, `.`, `\d \D \w \W \s \S \t \n \r \v \f \0 \xHH \uHHHH \cX`, escaped punctuation, classes with ranges and negation (`[]` matches nothing, `[^]` anything), `(...)`, `(?:...)`, `(?<name>...)`, `|`, `* + ? {n} {n,} {n,m}` (lazy forms too), `^` and `$`, and `{`, `}` and `]` as literals where `RegExp` reads them so. It refuses word boundaries (`\b`, `\B`), backreferences, lookarounds, a quantified assertion such as `(?:^)*` or `($)?` (valid `RegExp`, refused with `Pattern uses a quantified assertion, which is not supported`), other group kinds such as `(?i:...)`, legacy octal escapes, and escapes `RegExp` reads loosely (`\a`, `\p{L}`, a short `\x4`). A unit test checks it agrees with `RegExp` on a corpus of patterns and inputs (`packages/contracts/test/pattern-matcher.test.ts`).
- **The safe-pattern check is definition-time policy.** `packages/contracts/src/safe-pattern.ts` refuses the shapes that backtrack catastrophically in an engine like V8's, so none is ever stored: a repeat (`*`, `+`, `{n,m}` with m > 1) applied to a group that holds a repeat or an alternation (`(a+)+$`, `(a|a)*`, `([a-z]+)*`); more than 3 variable repeats; more than 2^22 estimated ways to match (the product of every group's alternatives and every variable repeat's range, divided by k! for k repeats), which refuses chains such as `(a|a)(a|a)…`; backreferences and lookarounds. It reads `[^](a+)+b]` as `[^]` then `(a+)+`, as JavaScript does, and refuses it.

Usual form patterns pass both: `[A-Z]{3}-\d{4}`, `(Mr|Mrs|Ms|Dr)\.? [A-Z][a-z]+`, `[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}`, `(foo|bar)`.

A value longer than the field's limit is refused before the pattern runs. A stored pattern that fails these checks (one written before a check existed; stored definitions are not re-parsed when read) is never run: the field is refused with `This field cannot be checked: its pattern is unsafe. Ask a team admin to fix the work type.` until an admin saves a new version.

## The API

Every route is under the team checks in [auth.md](auth.md): 401 without a session, 403 for a non-member, and the `X-GWD-CSRF` header on writes.

| Route | Who | What |
|---|---|---|
| `POST /api/v1/teams/:teamId/work-types` | admin | `{ slug, definition }`: creates the work type and its version 1 ([domain.md](domain.md)). 201; a slug the team already uses is 409, and so is a team at its cap of `QUOTA_WORK_TYPES_PER_TEAM` (50) active work types, archived ones not counted (`This team has reached its limit of 50 work types`, nothing written; [domain.md](domain.md) "Limits and quotas"). More than `MAX_OUTPUTS` (5) outputs, or email outputs naming more than `MAX_RECIPIENTS_PER_ITEM` (20) recipients in all, is 422 at `definition.outputs`, on this route and on a new version. An invalid body or definition is 422 `{ "errors": { "definition.fields.0.pattern": [...] } }`, keyed by path as on a new version, and writes no row. |
| `POST /api/v1/teams/:teamId/work-types/:id/versions` | admin | `{ definition }`: writes the next version (definitions are immutable). 201 with the work type and its new version. 409 `This work type is archived` while it is archived (GWP#55), writing nothing. An invalid definition is 422 `{ "errors": { "definition.fields.0.pattern": [...] } }`, keyed by path (a body that is not an object under `_form`), and writes no row. |
| `POST /api/v1/teams/:teamId/work-types/:id/items` | member | `{ data }`: validated against the latest version with `validateCapture`. The `Item` is created `open` with its first `ItemEvent`, `captured`, stored against that version's `workTypeVersionId`, and then processed ([process.md](process.md)): 201 with the item after its automated steps have run, so `in_progress` at a human step, `failed`, or `completed` (at once for a type with no steps). If processing fails once the item exists, the error is logged and recorded on the `capture.submit` span, and the answer is still 201 (unless the database cannot be read at all, which is a 500), with the item where processing stopped (often `open`), so the submitter does not capture it again; an admin resumes it, or the stuck-item sweeper does ([process.md](process.md) "Resume"). An archived work type (GWP#55) is 409 `This work type is archived` and writes nothing. Invalid data is 422 `{ "errors": CaptureErrors }` and writes nothing; a body without a `data` object is 400. Past `QUOTA_ITEMS_PER_SUBJECT_PER_MINUTE` (60) submits by one subject in a minute, on any team and for admins alike, it is 429 with `Retry-After` (the seconds until the subject's window, a minute from its first submit, ends) and writes nothing; the quota is taken before the body is read, so an invalid submit counts too ([domain.md](domain.md) "Limits and quotas"). The capture form then holds its submit button for those seconds ("You can submit again in N seconds."). |
| `GET /api/v1/teams/:teamId/work-types/:id/items` | member | One page of the work type's items across its versions, newest first: `{ "items": [...], "nextCursor": "..." }`, at most 100 items. Pass `nextCursor` back as `?cursor=` for the next page; it is `null` on the last. A cursor the list did not give out is 400. `?status=` (GWP#54) lists only the items in one `ItemStatus` (`open`, `in_progress`, `completed`, `failed`, `cancelled`); a filtered page's `nextCursor` continues the filtered list when passed with the same `?status=`. Any other status, an empty one or a repeated one is 400 `Invalid status`. |

JSON bodies are limited to 100 kB (`apps/api/src/app.ts`, 413 above it), which with the pattern budgets bounds the work one request can ask for. Another team's work type is 404. Both definition routes parse the body once, with the contract, and answer a refusal 422 `{ errors }` keyed by path, the shape the builder shows against the setting it names (`parseDefinitionBody`, `apps/api/src/common/zod.ts`); the service then checks steps and outputs on that parsed value without parsing it again, and their failures are 422 `{ errors }` too ([process.md](process.md)). Before GWP#21 creating a work type answered 400 with `issues`.

The item list is keyset-paged on `(createdAt, id)`, the order itself, so items that share a timestamp are each listed once; the cursor is that pair for the page's last item, opaque to callers. The status filter is a `WHERE` beside it, served by the index `Item(teamId, status, createdAt, id)` (GWP#54), which replaced `Item(teamId)`.

A version's fields are compiled into a validator (`captureValidator` in `packages/contracts/src/capture.ts`, which `validateCapture` calls) once: the API keeps one per `workTypeVersionId` in `apps/api/src/modules/capture/matcher-cache.ts`, least recently used evicted past 256 versions, so a submit does not rebuild the matchers for the definition's patterns. Each holds at most 20,000 matcher states, which bounds the cache's memory. Versions are immutable, so an entry never goes stale.

The submit runs inside the span `capture.submit` with the attributes `work_type.id` and `work_type.version`; processing's `process.step` spans are its children. A refused item does not mark the span as an error: it is answered 422, or 409 for an archived work type, after the span ends. RED metrics come from the global interceptor (`apps/api/src/common`).

## The builder and the capture form

In the SPA, a team opens from the team list:

- **Builder** (`apps/web/src/work-types/builder/`, admins): add, edit and remove fields; set the type, required, options and limits; reorder with the Move up and Move down buttons (keyboard accessible: focus stays with the moved field and the move is announced to screen readers). The builder shows the contract's definition-time errors beside the setting at fault and a live preview of the capture form. Saving a new work type creates it with version 1; saving an existing one posts its next version. The step editor beside the fields edits the steps ([process.md](process.md)); the output editor edits the outputs ([outputs.md](outputs.md)). A new work type starts with no steps and a `persist` output.
- **Capture** (`apps/web/src/work-types/capture/`, members): the form rendered from the latest version's fields, per-field errors from either side, and the list of the work type's items, 100 at a time with Load more, all of them or, with the Status select above the list (GWP#54), those in one status, where a change reloads the first page; items captured under older versions show their keys the current fields lack in extra columns headed by the key. Open shows an item's steps and history ([process.md](process.md)). The page validates against the version it loaded: when the API's errors name a key the form does not know (a field a newer version added, or one of the form's fields called `Unknown field`), it reloads the work type and shows those errors against the new version's fields, keeping what was typed (`apps/web/src/work-types/capture/item-list.ts`).

Teams are created and members added in the SPA: see [auth.md](auth.md) "Team membership".
