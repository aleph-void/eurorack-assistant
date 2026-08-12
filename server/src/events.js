import { EventEmitter } from 'node:events';

// Per-user progress event bus. The job worker publishes events here and the
// WebSocket server forwards them to that user's open sockets.
//
// Event payload shape:
//   { userId, kind: 'job', event: 'started'|'progress'|'completed'|'failed',
//     job: { id, type, module_id, question_id, status, attempts, error },
//     message?, at }
export function createBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    publish(userId, payload) {
      if (userId === null || userId === undefined) return;
      emitter.emit('event', { userId, at: new Date().toISOString(), ...payload });
    },
    subscribe(fn) {
      emitter.on('event', fn);
      return () => emitter.off('event', fn);
    },
  };
}
