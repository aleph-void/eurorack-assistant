// The app's stand-in for window.confirm(): the browser's dialog is unstyled,
// so views ask through here instead and <ConfirmDialog /> (mounted once in
// App.vue) draws the question in the house style.
//
// Exported as an object rather than a bare function so tests can spy on
// dialog.confirm the same way they spy on api.get.

import { reactive } from 'vue';

export const dialogState = reactive({
  open: false,
  title: '',
  message: '',
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  danger: false,
});

let resolve = null;

// Settle whatever question is open. Called by the component's buttons, the
// scrim, and Escape; also by a second confirm() arriving while one is up.
export function settleConfirm(answer) {
  const pending = resolve;
  resolve = null;
  dialogState.open = false;
  if (pending) pending(answer);
}

export const dialog = {
  /**
   * Ask the user to confirm an action.
   *
   * @param {object} options
   * @param {string} options.title    short heading, e.g. 'Delete patch'
   * @param {string} options.message  what happens if they go ahead
   * @param {string} [options.confirmLabel]  defaults to 'Confirm'
   * @param {string} [options.cancelLabel]   defaults to 'Cancel'
   * @param {boolean} [options.danger] draw the confirm button as destructive
   * @returns {Promise<boolean>} true when confirmed, false when dismissed
   */
  confirm({ title, message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
    // A question already on screen is treated as declined rather than lost.
    settleConfirm(false);
    dialogState.title = title;
    dialogState.message = message;
    dialogState.confirmLabel = confirmLabel;
    dialogState.cancelLabel = cancelLabel;
    dialogState.danger = danger;
    dialogState.open = true;
    return new Promise((r) => {
      resolve = r;
    });
  },
};
