import { describe, it, expect } from 'vitest';
import { describeJob, jobHeadline, jobTypeLabel } from '../src/jobLabels.js';

describe('jobLabels', () => {
  it('spells a job type as prose', () => {
    expect(jobTypeLabel('generate_patch')).toBe('Generate patch');
    expect(jobTypeLabel('')).toBe('Job');
  });

  it('names what a job is about: a module, a question, a rack, a system or a patch', () => {
    expect(describeJob({ module_manufacturer: 'Make Noise', module_name: 'Maths' })).toBe(
      'Make Noise Maths'
    );
    expect(describeJob({ question_prompt: 'why so quiet?' })).toBe('why so quiet?');
    expect(describeJob({ rack_name: 'main rack' })).toBe('main rack');
    expect(describeJob({ system_name: 'studio' })).toBe('studio');
    expect(describeJob({ patch_name: 'Evening drone' })).toBe('Evening drone');
    expect(describeJob({})).toBe('');
  });

  it('heads a toast with the job and its subject', () => {
    expect(jobHeadline({ type: 'generate_patch', patch_name: 'Evening drone' })).toBe(
      'Generate patch — Evening drone'
    );
  });
});
