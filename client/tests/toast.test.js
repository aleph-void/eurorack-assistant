import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { clearToasts, dismissToast, toast, toastState } from '../src/toast.js';
import ToastStack from '../src/components/ToastStack.vue';

beforeEach(() => {
  clearToasts();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  clearToasts();
});

describe('toast', () => {
  it('stacks the newest first and remembers which kind each one is', () => {
    toast.success('Manual analyzed', { title: 'Analyze manual — Maths' });
    toast.error('row 1 exceeds its 84HP capacity');

    expect(toastState.items.map((item) => item.kind)).toEqual(['error', 'success']);
    expect(toastState.items[0].message).toBe('row 1 exceeds its 84HP capacity');
    expect(toastState.items[1].title).toBe('Analyze manual — Maths');
  });

  it('takes a success away by itself, and keeps an error up far longer', () => {
    toast.success('Manual analyzed');
    toast.error('Could not reach the server');

    vi.advanceTimersByTime(5000);
    expect(toastState.items.map((item) => item.kind)).toEqual(['error']);

    vi.advanceTimersByTime(7000);
    expect(toastState.items).toHaveLength(0);
  });

  // A rack import finishes a job per module; twenty of the same line would
  // otherwise be twenty toasts.
  it('counts a repeat up on the toast already on screen', () => {
    toast.success('Finished.', { title: 'Find manual — 2hp ARP' });
    toast.success('Finished.', { title: 'Find manual — 2hp ARP' });
    toast.success('Finished.', { title: 'Find manual — Maths' });

    expect(toastState.items).toHaveLength(2);
    expect(toastState.items[1].count).toBe(2);

    // The repeat also restarts the clock, so the count is readable.
    vi.advanceTimersByTime(4000);
    expect(toastState.items).toHaveLength(2);
  });

  it('never shows more than four at once, dropping the oldest', () => {
    for (let i = 1; i <= 6; i += 1) toast.info(`line ${i}`);
    expect(toastState.items.map((item) => item.message)).toEqual([
      'line 6',
      'line 5',
      'line 4',
      'line 3',
    ]);
    // The dropped ones take their timers with them: nothing left to fire.
    vi.advanceTimersByTime(60000);
    expect(toastState.items).toHaveLength(0);
  });

  it('says nothing when there is nothing to say', () => {
    expect(toast.error('')).toBeNull();
    expect(toastState.items).toHaveLength(0);
  });
});

describe('ToastStack', () => {
  it('draws each toast in its colour and dismisses it on demand', async () => {
    const wrapper = mount(ToastStack);
    toast.error('does not fit in this 84HP row', { title: 'Layout not saved' });
    toast.success('Finished.', { title: 'Analyze manual — Maths' });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test="toast-success"]').exists()).toBe(true);
    const failure = wrapper.find('[data-test="toast-error"]');
    expect(failure.text()).toContain('Layout not saved');
    // Read by a screen reader as it arrives, not when the reader next pauses.
    expect(failure.attributes('role')).toBe('alert');

    const id = toastState.items.find((item) => item.kind === 'error').id;
    await wrapper.find(`[data-test="toast-dismiss-${id}"]`).trigger('click');
    expect(wrapper.find('[data-test="toast-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="toast-success"]').exists()).toBe(true);
  });

  // Twelve seconds is still a sentence that can run out mid-read.
  it('holds a toast open while the pointer is on it', async () => {
    const wrapper = mount(ToastStack);
    toast.success('Finished.');
    await wrapper.vm.$nextTick();

    await wrapper.find('[data-test="toast-success"]').trigger('mouseenter');
    vi.advanceTimersByTime(30000);
    expect(toastState.items).toHaveLength(1);

    await wrapper.find('[data-test="toast-success"]').trigger('mouseleave');
    vi.advanceTimersByTime(5000);
    expect(toastState.items).toHaveLength(0);
  });

  it('is out of the way of the page when it holds nothing', () => {
    const wrapper = mount(ToastStack);
    expect(wrapper.findAll('.toast')).toHaveLength(0);
    dismissToast(999); // an id that was never there is not an error
  });
});
