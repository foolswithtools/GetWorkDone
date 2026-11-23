import { describe, expect, it } from 'vitest';
import { createNavigator, linkProps, parseRoute, rememberSignInPath, routePath, SIGN_IN_PATH_KEY, takeSignInRoute, type HistoryWindow, type KnownRoute } from './routing.js';

describe('parseRoute and routePath (GWP#98)', () => {
  const routes: [string, KnownRoute][] = [
    ['/', { kind: 'teams' }],
    ['/teams/t1', { kind: 'team', teamId: 't1' }],
    ['/teams/t1/members', { kind: 'members', teamId: 't1' }],
    ['/teams/t1/work-types/new', { kind: 'new-work-type', teamId: 't1' }],
    ['/teams/t1/work-types/w1/edit', { kind: 'edit-work-type', teamId: 't1', workTypeId: 'w1' }],
    ['/teams/t1/work-types/w1/capture', { kind: 'capture', teamId: 't1', workTypeId: 'w1' }],
    ['/teams/t1/items/i1', { kind: 'item', teamId: 't1', itemId: 'i1' }],
  ];

  it.each(routes)('%s round-trips', (path, route) => {
    expect(parseRoute(path)).toEqual(route);
    expect(routePath(route)).toBe(path);
  });

  it('percent-encodes ids and decodes them again', () => {
    const route: KnownRoute = { kind: 'item', teamId: 'a b/c', itemId: 'é?#%' };
    const path = routePath(route);
    expect(path).toBe('/teams/a%20b%2Fc/items/%C3%A9%3F%23%25');
    expect(parseRoute(path)).toEqual(route);
  });

  it.each([
    '/teams/', '/teams', '/teams/a/b/c', '/api/v1/teams', '/no-such-page', '', 'teams/t1', '/teams/t1/',
    '/teams//members', '/teams/t1/work-types/w1', '/teams/t1/work-types/w1/delete', '/teams/t1/items/',
    '/teams/%E0%A4%A/members', '//evil.example/x', 'https://evil.example', '/\\evil.example',
  ])('%j is not found', (path) => {
    expect(parseRoute(path)).toEqual({ kind: 'not-found' });
  });

  it('keeps the edit and capture paths of a work type whose id is "new"', () => {
    // /work-types/new is the builder; a work type whose id is "new" still has its edit and capture paths.
    expect(parseRoute('/teams/t1/work-types/new/capture')).toEqual({ kind: 'capture', teamId: 't1', workTypeId: 'new' });
  });
});

describe('the path kept across sign-in', () => {
  function storage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
  }

  it('remembers the path and gives it back once', () => {
    const s = storage();
    rememberSignInPath(s, '/teams/t1/items/i1');
    expect(s.values.get(SIGN_IN_PATH_KEY)).toBe('/teams/t1/items/i1');
    expect(takeSignInRoute(s)).toEqual({ kind: 'item', teamId: 't1', itemId: 'i1' });
    expect(takeSignInRoute(s)).toBeUndefined();
  });

  it.each(['//evil.example/x', 'https://evil.example', '/no-such-page', ''])('drops a stored %j', (stored) => {
    const s = storage({ [SIGN_IN_PATH_KEY]: stored });
    expect(takeSignInRoute(s)).toBeUndefined();
    expect(s.values.has(SIGN_IN_PATH_KEY)).toBe(false);
  });

  it('gives nothing when nothing was stored, or the teams list (nowhere to go)', () => {
    expect(takeSignInRoute(storage())).toBeUndefined();
    expect(takeSignInRoute(storage({ [SIGN_IN_PATH_KEY]: '/' }))).toBeUndefined();
  });

  it('never throws when storage is unavailable', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    expect(() => rememberSignInPath(broken, '/teams/t1')).not.toThrow();
    expect(takeSignInRoute(broken)).toBeUndefined();
    expect(takeSignInRoute(undefined)).toBeUndefined();
    expect(() => rememberSignInPath(undefined, '/teams/t1')).not.toThrow();
  });
});

describe('createNavigator', () => {
  function fakeWindow(pathname: string, state: unknown = null) {
    const listeners = new Set<() => void>();
    const entries: { path: string; state: unknown }[] = [{ path: pathname, state }];
    let index = 0;
    const win: HistoryWindow & { entries: typeof entries; back: () => void } = {
      entries,
      location: { get pathname() { return entries[index]!.path; } },
      history: {
        get state() { return entries[index]!.state; },
        pushState: (s: unknown, _unused: string, path: string) => { entries.splice(index + 1, Infinity, { path, state: s }); index++; },
        replaceState: (s: unknown, _unused: string, path: string) => { entries[index] = { path, state: s }; },
        back: () => win.back(),
      },
      addEventListener: (_type: 'popstate', listener: () => void) => void listeners.add(listener),
      removeEventListener: (_type: 'popstate', listener: () => void) => void listeners.delete(listener),
      back: () => { index--; listeners.forEach((l) => l()); },
    };
    return win;
  }

  it('reads the route from the location, and keeps the same object until the path changes', () => {
    const nav = createNavigator(fakeWindow('/teams/t1'));
    expect(nav.current()).toEqual({ kind: 'team', teamId: 't1' });
    expect(nav.current()).toBe(nav.current());
  });

  it('pushes a navigation, tells subscribers, and follows popstate', () => {
    const win = fakeWindow('/');
    const nav = createNavigator(win);
    let calls = 0;
    const unsubscribe = nav.subscribe(() => calls++);
    nav.navigate({ kind: 'capture', teamId: 't1', workTypeId: 'w1' });
    expect(win.entries.map((e) => e.path)).toEqual(['/', '/teams/t1/work-types/w1/capture']);
    expect(nav.current()).toEqual({ kind: 'capture', teamId: 't1', workTypeId: 'w1' });
    expect(calls).toBe(1);
    win.back();
    expect(nav.current()).toEqual({ kind: 'teams' });
    expect(calls).toBe(2);
    unsubscribe();
    nav.navigate({ kind: 'team', teamId: 't1' });
    expect(calls).toBe(2);
  });

  it('replaces the entry when asked', () => {
    const win = fakeWindow('/');
    const nav = createNavigator(win);
    nav.navigate({ kind: 'team', teamId: 't1' }, { replace: true });
    expect(win.entries.map((e) => e.path)).toEqual(['/teams/t1']);
  });

  it('records where an item was opened from, so its Back returns there; a deep link has none', () => {
    const win = fakeWindow('/teams/t1/work-types/w1/capture');
    const nav = createNavigator(win);
    expect(nav.from()).toBeUndefined();
    nav.navigate({ kind: 'item', teamId: 't1', itemId: 'i1' }, { from: nav.current() });
    expect(nav.from()).toEqual({ kind: 'capture', teamId: 't1', workTypeId: 'w1' });
    // A stored "from" that is not a known path is ignored.
    expect(createNavigator(fakeWindow('/teams/t1/items/i1', { from: '//evil.example' })).from()).toBeUndefined();
    expect(createNavigator(fakeWindow('/teams/t1/items/i1', { from: 42 })).from()).toBeUndefined();
  });

  it('keeps a value in the current entry, beside its from, and reads it back after Back and Forward', () => {
    const win = fakeWindow('/teams/t1');
    const nav = createNavigator(win);
    nav.navigate({ kind: 'capture', teamId: 't1', workTypeId: 'w1' }, { from: nav.current() });
    expect(nav.entryValue('status')).toBeUndefined();
    nav.setEntryValue('status', 'failed');
    expect(win.entries[1]).toEqual({ path: '/teams/t1/work-types/w1/capture', state: { from: '/teams/t1', status: 'failed' } });
    expect(nav.entryValue('status')).toBe('failed');
    expect(nav.from()).toEqual({ kind: 'team', teamId: 't1' });
    nav.setEntryValue('status', undefined);
    expect(nav.entryValue('status')).toBeUndefined();
    // A value of another type is not handed back.
    expect(createNavigator(fakeWindow('/', { status: 3 })).entryValue('status')).toBeUndefined();
  });

  it('goes back one entry', () => {
    const win = fakeWindow('/teams/t1');
    const nav = createNavigator(win);
    nav.subscribe(() => undefined);
    nav.navigate({ kind: 'item', teamId: 't1', itemId: 'i1' }, { from: nav.current() });
    nav.back();
    expect(nav.current()).toEqual({ kind: 'team', teamId: 't1' });
  });

  it('does not push the path it is already on', () => {
    const win = fakeWindow('/teams/t1');
    const nav = createNavigator(win);
    let calls = 0;
    nav.subscribe(() => calls++);
    nav.navigate({ kind: 'team', teamId: 't1' });
    expect(win.entries).toHaveLength(1);
    expect(calls).toBe(0);
  });
});

describe('linkProps', () => {
  const click = (overrides: Partial<{ button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => {
    const event = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, prevented: false, preventDefault() { event.prevented = true; }, ...overrides };
    return event;
  };

  it('navigates in place on a plain click', () => {
    const to: KnownRoute[] = [];
    const props = linkProps({ navigate: (route) => void to.push(route) }, { kind: 'teams' });
    expect(props.href).toBe('/');
    const event = click();
    props.onClick(event);
    expect(event.prevented).toBe(true);
    expect(to).toEqual([{ kind: 'teams' }]);
  });

  it.each([{ button: 1 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }])('leaves %j to the browser', (overrides) => {
    const to: KnownRoute[] = [];
    const event = click(overrides);
    linkProps({ navigate: (route) => void to.push(route) }, { kind: 'team', teamId: 't1' }).onClick(event);
    expect(event.prevented).toBe(false);
    expect(to).toEqual([]);
  });
});
