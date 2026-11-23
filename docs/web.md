# The web app: structure and stylesheet

`apps/web` is the Vite and React SPA that `apps/api` serves as static files (D-026). It has three runtime dependencies (`react`, `react-dom`, `@getworkdone/contracts`) and builds to one JS and one CSS file in `apps/web/dist/assets`. Decisions are cited by number from the program register (spec §9.4) and never copied here.

## Structure

| Path | What it holds |
|---|---|
| `src/main.tsx` | Entry point: imports `styles/base.css` first, then renders `App` into `#root`. |
| `src/App.tsx` | The page shell (`<main>`): the API health line and `Auth`. |
| `src/routing.ts` | The SPA's own router (GWP#98): each view's path, `useRoute`, and the path kept across sign-in (below). |
| `src/not-found.tsx` | The Not found view: an unknown path, a team the person is not in, or an unknown work type. |
| `src/traced-fetch.ts` | `fetch` with a W3C `traceparent`, used for every API call. |
| `src/auth` | Sign-in state from `/api/v1/me`, the sign-in link and sign-out ([auth.md](auth.md)). |
| `src/teams` | Team membership API and the Members panel (GWP#20). |
| `src/work-types` | A team's work types: the schema builder, its step and output editors (`builder/`), and the capture page with its form, item list and exports panel (`capture/`) ([capture.md](capture.md), [process.md](process.md), [outputs.md](outputs.md)). |
| `src/items` | The item view: history, deliveries, resume, data edits, cancel and a step's decision and comment ([process.md](process.md)). |
| `src/r4c` | The request-4-change widget: `widget.ts` loads it and `R4cWidget.tsx` mounts it ([r4c.md](r4c.md)). |
| `src/styles` | `base.css`, and `contrast.ts`, the WCAG contrast ratio its unit test uses. |

## Addresses

Every view has its own path, so a reload, the browser's Back and Forward, and a pasted link land on the same view (GWP#98). `src/routing.ts` holds the paths with no dependency: `parseRoute(pathname)` and `routePath(route)` are pure, and ids in a path are percent-encoded.

| Path | View |
|---|---|
| `/` | Your teams |
| `/teams/:teamId` | The team's work types, and what is waiting for you |
| `/teams/:teamId/members` | The Members panel |
| `/teams/:teamId/work-types/new` | The builder, for a new work type |
| `/teams/:teamId/work-types/:workTypeId/edit` | The builder, for the work type's next version |
| `/teams/:teamId/work-types/:workTypeId/capture` | The capture page and its items |
| `/teams/:teamId/items/:itemId` | The item view |

Any other path shows Not found with a link to `/`; so does a team the person is not in (the API answers 403 or 404 for it alike) or a work type the team does not have. An unknown item shows the item view's "Could not load the item."

Buttons call `history.pushState` through the navigator `useRoute` reads, and a `popstate` listener follows Back and Forward. Opening an item records the view it was opened from in the history entry's state, so **Back to the items** goes one entry back to that list; a pasted item link has none and goes to the team's page. The capture page keeps its status filter in its own entry's state, so the filter is still set on the way back from an item and after a reload (it is not in the address). The API answers these paths with `index.html` (`apps/api/src/spa/spa.controller.ts`), and never under `/api/` or `/__r4c/`; a path whose last segment holds a `.` is a missing file, not a view, so ids must not contain one (the API's are UUIDs).

Sign-in always lands on `/` (`GET /auth/callback`). The **Sign in** link stores the current path in `sessionStorage` first, and once signed in the SPA goes there once, replacing `/`, if it parses to a known view; anything else, such as `//evil.example/x`, is dropped, so the navigation never leaves the origin. Query-string state (the items list's status filter and cursor) is not in the address yet.

## The stylesheet

`src/styles/base.css` is the SPA's base stylesheet (GWP#47); `src/styles/r4c-tokens.css` (GWP#10, below) is the only other, and Vite bundles the two into one built file. It is plain CSS: no component library, no web font and no third-party origin, so the page needs only `style-src 'self'` and `font-src 'self'` (the policy is in [security.md](security.md)). `index.html` has no inline `<style>`; Vite links the built file from `dist/index.html`.

It sets theme tokens on `:root` (below), `color-scheme: light dark`, and a baseline: the body font and colours from the tokens; `main` centred at up to 72rem with `--gwd-spacing` padding; tables with collapsed borders and left-aligned headers; form controls that inherit the font with a `--gwd-color-border` border and `--gwd-radius`; `button` and `a[role='button']` (the sign-in link) in the accent with `--gwd-color-bg` text; errors (`[role='alert']`, `.field-errors`) in `--gwd-color-error`; and a 2px accent outline, offset 2px, on `:focus-visible`.

The colour scheme follows `prefers-color-scheme` only; there is no user-selectable theme.

## Tokens

| Token | Light | Dark |
|---|---|---|
| `--gwd-font-family` | system font stack (`system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`) | same |
| `--gwd-color-fg` | `#1a1a1a` | `#e8e8e8` |
| `--gwd-color-bg` | `#ffffff` | `#121212` |
| `--gwd-color-accent` | `#0b57d0` | `#8ab4f8` |
| `--gwd-color-error` | `#b00020` | `#ff8a80` |
| `--gwd-color-border` | `#767676` | `#8a8a8a` |
| `--gwd-radius` | `4px` | same |
| `--gwd-spacing` | `1rem` | same |

Contrast against `--gwd-color-bg` (WCAG 2.2 AA asks for 4.5:1 for text):

| Pair | Light | Dark |
|---|---|---|
| fg on bg | 17.40 | 15.29 |
| accent on bg (also bg text on an accent button) | 6.39 | 8.89 |
| error on bg | 7.33 | 8.21 |

`src/styles/tokens.test.ts` (unit) reads `base.css`, extracts the colour tokens from the `:root` block and the dark block, and fails if any of these pairs drops below 4.5:1 or a token is missing. Change a colour and run `pnpm test:unit`. `tests/e2e/styles.spec.ts` checks the built page: one linked stylesheet, no `<style>`, tokens resolved in both schemes, and the focus outline.

## `.visually-hidden`

`.visually-hidden` keeps text in the accessibility tree while it takes 1px on screen (absolute, 1px by 1px, `overflow: hidden`, `clip-path: inset(50%)`). It names the item list's Actions column (`work-types/capture/CapturePage.tsx`) and holds the builder's live announcement (`work-types/builder/Builder.tsx`). `tests/e2e/builder-capture.spec.ts` checks both are still found by role or text and are at most 1 by 1 pixels.

## The request-4-change widget tokens

The request-4-change widget reads six `--r4c-*` custom properties (spec §4.2). GWP#10 maps them onto these tokens in its own `src/styles/r4c-tokens.css` (checked by `src/styles/r4c-tokens.test.ts`; the embed is in [r4c.md](r4c.md)), for example `--r4c-color-accent: var(--gwd-color-accent)`, and likewise `--r4c-font-family`, `--r4c-color-fg`, `--r4c-color-bg`, `--r4c-radius` and `--r4c-spacing` from the `--gwd-*` token of the same name. `base.css` defines nothing `--r4c-*`.
