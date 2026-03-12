// lib/transform/constants.js

function get(obj, dotPath) {
  return String(dotPath)
    .split('.')
    .reduce((current, key) => (current != null ? current[key] : undefined), obj);
}

/**
 * Recursively replace `${constants.<path>}` placeholders in any string value within a
 * JSON-serializable structure (object, array, or primitive).
 *
 * Operates by serializing to JSON, replacing, then deserializing — so the input must be
 * JSON-serializable. Returns a new value; the original is not mutated.
 *
 * @param {*}      config    - any JSON-serializable value
 * @param {object} constants - constants object (e.g., loaded from config/constants.json)
 * @returns {*}              - new value with all `${constants.*}` placeholders resolved
 */
export function resolveConstantsDeep(config, constants = {}) {
  const serialized = JSON.stringify(config).replace(
    /\$\{constants\.([^}]+)\}/g,
    (_, path) => {
      const value = get(constants, path);
      return value == null ? '' : String(value);
    }
  );
  return JSON.parse(serialized);
}
