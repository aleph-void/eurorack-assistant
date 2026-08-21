import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { testGlobal } from '../setup.js';

vi.mock('../../src/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const routerPush = vi.fn();
const routerReplace = vi.fn();
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useRouter: () => ({ push: routerPush, replace: routerReplace }),
    useRoute: () => ({ query: {}, path: '/patches/7/voice' }),
  };
});

import { api } from '../../src/api.js';
import PatchVoiceView from '../../src/views/PatchVoiceView.vue';
import VoicePatchPanel from '../../src/components/VoicePatchPanel.vue';
import { krellPatch } from '../patchFixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PatchVoiceView', () => {
  it('hands the panel both ends of every cable that could be plugged, and the words to expect', async () => {
    api.get.mockResolvedValue(krellPatch);
    const wrapper = mount(PatchVoiceView, { props: { id: '7' }, global: testGlobal() });
    await flushPromises();

    expect(wrapper.find('h1').text()).toContain('Krell');
    const panel = wrapper.findComponent(VoicePatchPanel);
    expect(panel.props('patchId')).toBe('7');
    // The lists are handed over as thunks: they are read when the recogniser
    // starts listening, not when the page is drawn.
    expect(panel.props('fromCandidates')().some((c) => c.jack_name === 'EOR')).toBe(true);
    expect(panel.props('toCandidates')().some((c) => c.jack_name === 'Signal In')).toBe(true);
    // A recogniser has never heard of Maths, so it is told the names.
    expect(panel.props('vocabulary')()).toContain('Maths');
  });
});
