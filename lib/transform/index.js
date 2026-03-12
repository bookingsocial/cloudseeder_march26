// lib/transform/index.js
// Re-exports the full public transform API.

export { shapeRecord, assertRequiredFields } from './shape.js';
export { applyTransforms } from './transforms.js';
export { resolveConstantsDeep } from './constants.js';
export { resolveReferences, resolveRef, inferTargetObject, getByPath } from './ref-solver.js';
