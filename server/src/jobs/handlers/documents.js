// Which documents a saved upload is, read off its name.
//
// A user's upload has a free-form display name and keeps its original file
// name, so both are searched: either spelling style people naturally use for
// a saved Perfect Circuit page ("Perfect Circuit", "Perfect_Circuit", a
// hyphen), and whatever an open-source module's build document got called
// ("build doc", "Build Guide", "assembly instructions", "BOM and build").

// User uploads have a free-form display name and retain their original file
// name. Accept either spelling style people naturally use for a saved
// Perfect Circuit page ("Perfect Circuit", "Perfect_Circuit", or a hyphen).
export function isPerfectCircuitDocument(document) {
  const label = `${document?.name || ''} ${document?.original_name || ''}`;
  return /(?:^|[^a-z])perfect[\s_-]*circuit(?:[^a-z]|$)/i.test(label);
}

// The same, for the build document an open-source module publishes in place
// of a manual — whatever the uploader called it ("build doc", "Build Guide",
// "assembly instructions", "BOM and build").
export function isBuildDocument(document) {
  const label = `${document?.name || ''} ${document?.original_name || ''}`;
  return /(?:^|[^a-z])(build|assembly)(?:[^a-z]|$)/i.test(label);
}
