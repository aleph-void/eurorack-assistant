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
    expect(adminRoutes.sort()).toEqual(['config', 'users']);
  });
});
