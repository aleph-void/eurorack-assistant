import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { NAVIGATION_GROUPS, findDestination } from '../src/navigation.js';
import { routes } from '../src/router.js';

describe('navigation destinations', () => {
  it('gives each menu destination one home and a working route', () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    const destinations = NAVIGATION_GROUPS.flatMap((group) => group.items);
    expect(new Set(destinations.map((item) => item.to)).size).toBe(destinations.length);
    for (const item of destinations) {
      expect(router.resolve(item.to).matched.length, item.to).toBeGreaterThan(0);
      expect(findDestination(item.to)).toBe(item);
    }
  });

  it('keeps record subpages in their global home without matching similar prefixes', () => {
    expect(findDestination('/modules/4/jacks/input')?.to).toBe('/modules');
    expect(findDestination('/patches/7/notes')?.to).toBe('/patches');
    expect(findDestination('/compositions/2/patches/7')?.to).toBe('/compositions');
    expect(findDestination('/performances/3')?.to).toBe('/performances');
    expect(findDestination('/modules-extra')).toBeUndefined();
    expect(findDestination('/login')).toBeUndefined();
  });

  it('keeps standalone manual readers and device linking in their home section', () => {
    expect(findDestination('/manuals/abc')?.to).toBe('/search');
    expect(findDestination('/link')?.to).toBe('/devices');
  });
});
