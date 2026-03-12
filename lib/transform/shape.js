// lib/transform/shape.js

function get(obj, dotPath) {
  return String(dotPath)
    .split('.')
    .reduce((current, key) => (current != null ? current[key] : undefined), obj);
}

function set(obj, dotPath, value) {
  const keys = String(dotPath).split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}

function del(obj, dotPath) {
  const keys = String(dotPath).split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] == null) return;
    current = current[key];
  }
  delete current[keys[keys.length - 1]];
}

/**
 * Shape a record by applying fieldMap renames, defaults, and field removal.
 *
 * Processing order:
 *   1. `shape.removeFields`  — drop listed fields
 *   2. `shape.defaults`      — fill missing/undefined fields with default values
 *   3. `shape.fieldMap`      — rename source fields to destination fields
 *
 * @param {object} record  - input record (not mutated)
 * @param {object} config  - mapping config containing `shape` key
 * @returns {object}       - new record with shape applied
 */
export function shapeRecord(record, config) {
  const out = { ...record };

  for (const fieldPath of config?.shape?.removeFields || []) {
    del(out, fieldPath);
  }

  const defaults = config?.shape?.defaults || {};
  for (const [fieldPath, defaultValue] of Object.entries(defaults)) {
    if (get(out, fieldPath) === undefined) {
      set(out, fieldPath, defaultValue);
    }
  }

  const fieldMap = config?.shape?.fieldMap || {};
  for (const [srcPath, destPath] of Object.entries(fieldMap)) {
    if (srcPath !== destPath && get(out, srcPath) !== undefined) {
      set(out, destPath, get(out, srcPath));
      del(out, srcPath);
    }
  }

  return out;
}

/**
 * Assert that all required fields are present and non-empty on a record.
 * Throws on the first violation.
 *
 * @param {object}   record  - the record to validate
 * @param {string[]} fields  - dot-notation field paths that must be non-empty
 * @param {string}   [label] - label for the error message
 */
export function assertRequiredFields(record, fields = [], label = 'record') {
  for (const fieldPath of fields) {
    const value = get(record, fieldPath);
    if (value == null || value === '') {
      throw new Error(`Validation failed: '${label}' missing required field '${fieldPath}'`);
    }
  }
}
