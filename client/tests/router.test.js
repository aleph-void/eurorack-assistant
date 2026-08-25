import { describe, it, expect } from 'vitest';
import { guardRedirect, routes } from '../src/router.js';

const to = (name, meta = {}) => ({ name, meta, fullPath: `/${name}` });

describe('route guard', () => {
  it('sends logged-out users to login with a redirect back', () => {
    const redirect = guardRedirect(to('modules'), { isLoggedIn: false, isAdmin: false });
    expect(redirect).toMatchObject({ name: 'login', query: { redirect: '/modules' } });
  });

  it('allows public routes when logged out', () => {
    expect(guardRedirect(to('login', { public: true }), { isLoggedIn: false, isAdmin: false })).toBe(
      null
    );
  });

  it('blocks admin routes for regular users', () => {
    expect(guardRedirect(to('users', { admin: true }), { isLoggedIn: true, isAdmin: false }))
      .toMatchObject({ name: 'modules' });
  });

  it('allows admin routes for admins', () => {
    expect(guardRedirect(to('users', { admin: true }), { isLoggedIn: true, isAdmin: true })).toBe(
      null
    );
  });

  it('bounces logged-in users away from login', () => {
    expect(
      guardRedirect(to('login', { public: true }), { isLoggedIn: true, isAdmin: false })
    ).toMatchObject({ name: 'modules' });
  });

  it('forces users with a pending password change to the change form', () => {
    const state = { isLoggedIn: true, isAdmin: false, mustChangePassword: true };
    expect(guardRedirect(to('modules'), state)).toMatchObject({ name: 'change-password' });
    expect(guardRedirect(to('users', { admin: true }), state)).toMatchObject({
      name: 'change-password',
    });
    expect(guardRedirect(to('login', { public: true }), state)).toMatchObject({
      name: 'change-password',
    });
    expect(guardRedirect(to('change-password'), state)).toBe(null);
  });

  it('allows the change-password page without the forced flag', () => {
    expect(
      guardRedirect(to('change-password'), { isLoggedIn: true, isAdmin: false })
    ).toBe(null);
    expect(
      guardRedirect(to('change-password'), { isLoggedIn: false, isAdmin: false })
    ).toMatchObject({ name: 'login' });
  });

  it('marks the admin pages with the admin meta flag', () => {
    const adminRoutes = routes.filter((r) => r.meta?.admin).map((r) => r.name);
    expect(adminRoutes.sort()).toEqual(['config', 'csp-reports', 'users']);
  });
});

// A module and a patch are each a page per thing there is to know about them,
// every one of them taking the record's id as a prop.
describe('detail sub-pages', () => {
  const under = (prefix) =>
    routes.filter((r) => r.path.startsWith(prefix) && r.path !== prefix);

  it('gives every part of a module its own route', () => {
    const paths = under('/modules/:id/').map((r) => r.path.split('/').pop());
    expect(paths.sort()).toEqual([
      'bridges',
      'components',
      'documents',
      'expanders',
      // The three kinds of jack are three pages over one view, so the kind is
      // in the path rather than in three near-identical route definitions —
      // and every other component type is the same view again, addressed by
      // its type.
      ':kind(input|output|bidirectional)',
      ':type(knob|slider|button|toggle|switch|display|other)',
      'normalizations',
      'notes',
      'pairs',
      'parameters',
      'questions',
      'routes',
      'switches',
      'values',
      'videos',
    ].sort());
    // The jack pages map their path segment onto a component type, so they
    // pass a props FUNCTION; every other page takes the id straight through.
    expect(
      under('/modules/:id/').every((r) => r.props === true || typeof r.props === 'function')
    ).toBe(true);
  });

  it('gives every part of a patch its own route', () => {
    const pages = under('/patches/:id/').filter((r) => r.component);
    expect(pages.map((r) => r.path.split('/').pop()).sort()).toEqual([
      'cables',
      'flow',
      'links',
      'modules',
      'notes',
      'questions',
      'scope',
      'settings',
    ]);
    expect(pages.every((r) => r.props === true)).toBe(true);
  });

  // Patching by voice used to be a page of each patch. It is an account
  // setting now — one microphone, one footswitch, whatever patch is open.
  it('sends the old per-patch voice page to the account setting', () => {
    const voice = routes.find((r) => r.path === '/patches/:id/voice');
    expect(voice.component).toBeUndefined();
    expect(voice.redirect).toBe('/account/voice');
    expect(routes.find((r) => r.name === 'voice-settings').path).toBe('/account/voice');
  });

  it('sends the old one-page configuration URL to the control settings', () => {
    const config = routes.find((r) => r.path === '/patches/:id/config');
    expect(config.component).toBeUndefined();
    expect(config.redirect({ params: { id: '7' } })).toBe('/patches/7/settings');
  });
});
