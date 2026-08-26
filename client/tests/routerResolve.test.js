import { describe, it, expect } from 'vitest';
import { createRouter, createMemoryHistory } from 'vue-router';
import { routes } from '../src/router.js';

// The matcher is the half of the router the view tests stub out: they mount
// with RouterLink/RouterView stubbed, so nothing there ever asks the router to
// turn a path into a route. These do, for every shape of path the app uses —
// the plain ones, the ones carrying an :id, the two that constrain a param to
// a list of words, and the three redirects.
function router() {
  return createRouter({ history: createMemoryHistory(), routes });
}

describe('route matching', () => {
  it('names every static path', () => {
    const r = router();
    for (const [path, name] of [
      ['/login', 'login'],
      ['/modules', 'modules'],
      ['/racks', 'racks'],
      ['/systems', 'systems'],
      ['/patches', 'patches'],
      ['/import', 'import'],
      ['/search', 'search'],
      ['/ask', 'ask'],
      ['/questions', 'questions'],
      ['/jobs', 'jobs'],
      ['/notes', 'notes'],
      ['/shared', 'shared'],
      ['/devices', 'devices'],
      ['/link', 'link-device'],
      ['/account/password', 'change-password'],
      ['/account/llm', 'llm-settings'],
      ['/account/voice', 'voice-settings'],
      ['/admin/users', 'users'],
      ['/admin/config', 'config'],
    ]) {
      expect(r.resolve(path).name, path).toBe(name);
    }
  });

  it('carries the id of every per-record page', () => {
    const r = router();
    for (const [path, name] of [
      ['/modules/7', 'module-detail'],
      ['/modules/7/components', 'module-components'],
      ['/modules/7/values', 'module-values'],
      ['/modules/7/parameters', 'module-parameters'],
      ['/modules/7/normalizations', 'module-normalizations'],
      ['/modules/7/switches', 'module-switches'],
      ['/modules/7/routes', 'module-routes'],
      ['/modules/7/pairs', 'module-pairs'],
      ['/modules/7/expanders', 'module-expanders'],
      ['/modules/7/bridges', 'module-bridges'],
      ['/modules/7/documents', 'module-documents'],
      ['/modules/7/videos', 'module-videos'],
      ['/modules/7/audio', 'module-audio'],
      ['/modules/7/links', 'module-links'],
      ['/modules/7/notes', 'module-notes'],
      ['/modules/7/questions', 'module-questions'],
      ['/patches/7', 'patch-detail'],
      ['/patches/7/cables', 'patch-cables'],
      ['/patches/7/settings', 'patch-settings'],
      ['/patches/7/flow', 'patch-flow'],
      ['/patches/7/gear', 'patch-gear'],
      ['/patches/7/links', 'patch-links'],
      ['/patches/7/audio', 'patch-audio'],
      ['/patches/7/scope', 'patch-scope'],
      ['/patches/7/notes', 'patch-notes'],
      ['/patches/7/modules', 'patch-modules'],
      ['/patches/7/questions', 'patch-questions'],
      ['/questions/7', 'question-detail'],
      ['/manuals/abc123', 'manual-text'],
      ['/shared/module/7', 'shared-item'],
    ]) {
      const route = r.resolve(path);
      expect(route.name, path).toBe(name);
      if (path.startsWith('/manuals')) expect(route.params.hash).toBe('abc123');
      else expect(String(route.params.id), path).toBe('7');
    }
  });

  // A jack page and a parts page constrain their param to a list of words, so
  // that /modules/7/jacks/input is a page and /modules/7/jacks/banana is not.
  it('takes only the jack kinds it names, and types the props from them', () => {
    const r = router();
    for (const kind of ['input', 'output', 'bidirectional']) {
      const route = r.resolve(`/modules/7/jacks/${kind}`);
      expect(route.name, kind).toBe('module-jacks');
      expect(route.params.kind).toBe(kind);
      const props = route.matched[0].props.default(route);
      expect(props).toEqual({ id: '7', type: `${kind}_jack` });
    }
    expect(r.resolve('/modules/7/jacks/banana').name).toBeUndefined();
  });

  it('takes only the part types it names', () => {
    const r = router();
    for (const type of ['knob', 'slider', 'button', 'toggle', 'switch', 'display', 'other']) {
      const route = r.resolve(`/modules/7/parts/${type}`);
      expect(route.name, type).toBe('module-parts');
      expect(route.params.type).toBe(type);
    }
    expect(r.resolve('/modules/7/parts/banana').name).toBeUndefined();
  });

  // Asserted by navigating rather than by resolving: resolve() reports the
  // location asked for, and only a navigation follows a redirect record.
  it('sends the retired pages where they went', async () => {
    const r = router();
    for (const [from, to] of [
      ['/', '/modules'],
      ['/patches/7/config', '/patches/7/settings'],
      ['/patches/7/voice', '/account/voice'],
    ]) {
      await r.push(from);
      expect(r.currentRoute.value.fullPath, from).toBe(to);
    }
  });
});
