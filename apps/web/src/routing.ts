// The SPA's own small router (GWP#98): every view has a path, so a reload, Back and Forward and a pasted
// link land on the same view. parseRoute and routePath are pure; createNavigator keeps the current route
// in step with the window's location (pushState on navigation, popstate on Back and Forward), and useRoute
// hands it to React. The API serves index.html for these paths (apps/api/src/spa/spa.controller.ts).

import { useSyncExternalStore } from 'react';

export type KnownRoute =
  | { kind: 'teams' }
  | { kind: 'team'; teamId: string }
  | { kind: 'members'; teamId: string }
  | { kind: 'new-work-type'; teamId: string }
  | { kind: 'edit-work-type'; teamId: string; workTypeId: string }
  | { kind: 'capture'; teamId: string; workTypeId: string }
  | { kind: 'item'; teamId: string; itemId: string };

export type Route = KnownRoute | { kind: 'not-found' };

const NOT_FOUND: Route = { kind: 'not-found' };

/**
 * The route a pathname names, or not-found. The path must start with one `/` and hold no empty segment
 * (so `//host/x` and `/teams/` are not found, and nothing parsed can leave the origin); ids are
 * percent-decoded, and a malformed escape is not found.
 */
export function parseRoute(pathname: string): Route {
  if (pathname === '/') return { kind: 'teams' };
  if (!pathname.startsWith('/')) return NOT_FOUND;
  let segments: string[];
  try {
    segments = pathname.slice(1).split('/').map(decodeURIComponent);
  } catch {
    return NOT_FOUND;
  }
  if (segments.some((s) => s === '')) return NOT_FOUND;
  const [first, teamId, section, id, action, ...rest] = segments;
  if (first !== 'teams' || teamId === undefined || rest.length > 0) return NOT_FOUND;
  if (section === undefined) return { kind: 'team', teamId };
  if (section === 'members' && id === undefined) return { kind: 'members', teamId };
  if (section === 'items' && id !== undefined && action === undefined) return { kind: 'item', teamId, itemId: id };
  if (section === 'work-types' && id !== undefined) {
    if (action === undefined) return id === 'new' ? { kind: 'new-work-type', teamId } : NOT_FOUND;
    if (action === 'edit') return { kind: 'edit-work-type', teamId, workTypeId: id };
    if (action === 'capture') return { kind: 'capture', teamId, workTypeId: id };
  }
  return NOT_FOUND;
}

/** The path of a route, ids percent-encoded; parseRoute(routePath(r)) is r. */
export function routePath(route: KnownRoute): string {
  const team = route.kind === 'teams' ? '' : `/teams/${encodeURIComponent(route.teamId)}`;
  switch (route.kind) {
    case 'teams': return '/';
    case 'team': return team;
    case 'members': return `${team}/members`;
    case 'new-work-type': return `${team}/work-types/new`;
    case 'edit-work-type': return `${team}/work-types/${encodeURIComponent(route.workTypeId)}/edit`;
    case 'capture': return `${team}/work-types/${encodeURIComponent(route.workTypeId)}/capture`;
    case 'item': return `${team}/items/${encodeURIComponent(route.itemId)}`;
  }
}

const known = (route: Route): route is KnownRoute => route.kind !== 'not-found';

// Sign-in always lands on `/` (GET /auth/callback); the signed-out view keeps the path it was opened on
// for the signed-in view to return to, once.
export const SIGN_IN_PATH_KEY = 'gwd.signInPath';

type PathStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Keeps the signed-out view's path for after sign-in; a storage that refuses is ignored. */
export function rememberSignInPath(storage: PathStorage | undefined, pathname: string): void {
  try {
    storage?.setItem(SIGN_IN_PATH_KEY, pathname);
  } catch {
    // Without storage, sign-in lands on the teams list as before.
  }
}

/**
 * The route kept before sign-in, removed as it is read; undefined when there is none, it is the teams list,
 * or it is not a known path (so `//evil.example/x` is dropped and the navigation never leaves the origin).
 */
export function takeSignInRoute(storage: PathStorage | undefined): KnownRoute | undefined {
  let stored: string | null;
  try {
    stored = storage?.getItem(SIGN_IN_PATH_KEY) ?? null;
    storage?.removeItem(SIGN_IN_PATH_KEY);
  } catch {
    return undefined;
  }
  if (stored === null) return undefined;
  const route = parseRoute(stored);
  return known(route) && route.kind !== 'teams' ? route : undefined;
}

/** The parts of `window` the navigator uses. */
export type HistoryWindow = {
  location: { readonly pathname: string };
  history: { readonly state: unknown; pushState(state: unknown, unused: string, url: string): void; replaceState(state: unknown, unused: string, url: string): void; back(): void };
  addEventListener(type: 'popstate', listener: () => void): void;
  removeEventListener(type: 'popstate', listener: () => void): void;
};

export type NavigateOptions = { replace?: boolean; from?: Route };

export type RouteNavigator = ReturnType<typeof createNavigator>;

/**
 * The current route of a window, the same object until its path changes (as useSyncExternalStore needs).
 * navigate pushes (or replaces) a history entry; `from` records the view the entry was opened from in its
 * history state, so an item's Back returns to the list it was opened from (GWP#98). A view keeps its own
 * small values (the capture page's status filter) in its entry's state too, so they survive the round trip
 * to an item and back, and a reload.
 */
export function createNavigator(win: HistoryWindow) {
  const listeners = new Set<() => void>();
  let path = win.location.pathname;
  let route = parseRoute(path);

  const read = () => {
    if (win.location.pathname === path) return false;
    path = win.location.pathname;
    route = parseRoute(path);
    return true;
  };
  const notify = () => listeners.forEach((listener) => listener());
  const entry = (): Record<string, unknown> => {
    const state: unknown = win.history.state;
    return typeof state === 'object' && state !== null ? state as Record<string, unknown> : {};
  };
  const onPopState = () => {
    if (read()) notify();
  };

  return {
    current: (): Route => route,
    /** The route the current history entry was opened from, when it recorded a known one. */
    from(): KnownRoute | undefined {
      const stored = entry().from;
      const from = typeof stored === 'string' ? parseRoute(stored) : NOT_FOUND;
      return known(from) ? from : undefined;
    },
    /** A string the current entry keeps under `key`, set with setEntryValue. */
    entryValue(key: string): string | undefined {
      const value = entry()[key];
      return typeof value === 'string' ? value : undefined;
    },
    /** Keeps (or, with undefined, drops) a string in the current entry's state; the path stays. */
    setEntryValue(key: string, value: string | undefined) {
      const next = Object.fromEntries(Object.entries(entry()).filter(([k]) => k !== key));
      win.history.replaceState(value === undefined ? next : { ...next, [key]: value }, '', path);
    },
    /** One entry back; popstate then moves the route. */
    back() {
      win.history.back();
    },
    navigate(to: KnownRoute, { replace = false, from }: NavigateOptions = {}) {
      const target = routePath(to);
      if (target === path && !replace) return;
      const state = from && known(from) ? { from: routePath(from) } : null;
      if (replace) win.history.replaceState(state, '', target);
      else win.history.pushState(state, '', target);
      if (read()) notify();
    },
    subscribe(listener: () => void) {
      if (listeners.size === 0) win.addEventListener('popstate', onPopState);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) win.removeEventListener('popstate', onPopState);
      };
    },
  };
}

/** The parts of a click a link reads. */
export type LinkClick = { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void };

/**
 * An in-app link's href and click handler: a plain left click navigates without reloading the page; a
 * modified or middle click is left to the browser (a new tab or window opens the same path).
 */
export function linkProps(nav: Pick<RouteNavigator, 'navigate'>, to: KnownRoute) {
  return {
    href: routePath(to),
    onClick(event: LinkClick) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      nav.navigate(to);
    },
  };
}

let windowNavigator: RouteNavigator | undefined;

/** The browser window's navigator, made on first use. */
export function browserNavigator(): RouteNavigator {
  return (windowNavigator ??= createNavigator(window));
}

/** The current route, re-rendering on navigation and on Back and Forward. */
export function useRoute(): Route {
  const nav = browserNavigator();
  return useSyncExternalStore(nav.subscribe, nav.current);
}
