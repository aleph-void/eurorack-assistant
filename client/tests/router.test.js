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

  it('marks the admin pages with the admin meta flag', () => {
    const adminRoutes = routes.filter((r) => r.meta?.admin).map((r) => r.name);
    expect(adminRoutes.sort()).toEqual(['config', 'users']);
  });
});
