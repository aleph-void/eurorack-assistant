// The shape a patch file is allowed to have.
//
// A document arrives from outside — somebody else's install, or a text
// editor. These are what stop a hand-written one from asking the server to
// write a million rows.

export const PATCH_FORMAT = 'eurorack-assistant.patch';
export const PATCH_FORMAT_VERSION = 2;

export const LIMITS = {
  modules: 500,
  ports: 200,
  cables: 4000,
  settings: 4000,
  groups: 200,
  links: 500,
  jacks: 200,
  text: 500,
  body: 4000,
};

export const JACK_TYPES = ['input_jack', 'output_jack', 'bidirectional_jack'];
export const LINK_KINDS = ['expander', 'bridge'];
