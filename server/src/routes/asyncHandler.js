// Wraps an async route handler so a rejection lands in next() — the
// per-handler try/catch this replaces.
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).then(undefined, next);
};
