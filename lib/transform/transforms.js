// lib/transform/transforms.js

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

function applyRecordTemplates(template, record) {
  if (typeof template !== 'string') return template;
  return template.replace(/\$\{([^}]+)\}/g, (_, path) => {
    const value = get(record, path.trim());
    return value == null ? '' : String(value);
  });
}

/**
 * Apply a list of named transform operations to a record.
 *
 * Supported operations:
 *   - `assign`   — `out`, `expr` (template string resolved against record)
 *   - `copy`     — `out`, `from` (source field path)
 *   - `rename`   — `from`, `to`; deletes source
 *   - `remove`   — `field`
 *   - `coalesce` — `out`, `from` (array of source paths), `default` (fallback)
 *   - `concat`   — `out`, `parts` (array of template strings joined with no separator)
 *
 * @param {object} record     - input record (not mutated)
 * @param {Array}  transforms - list of transform operation objects
 * @returns {object}          - new record with all transforms applied
 */
export function applyTransforms(record, transforms = []) {
  let out = { ...record };

  for (const transform of transforms) {
    const { op } = transform || {};
    if (!op) continue;

    if (op === 'assign') {
      const value = applyRecordTemplates(transform.expr, out);
      set(out, transform.out, value);

    } else if (op === 'copy') {
      set(out, transform.out, get(out, transform.from));

    } else if (op === 'rename') {
      const value = get(out, transform.from);
      if (value !== undefined) {
        set(out, transform.to, value);
        del(out, transform.from);
      }

    } else if (op === 'remove') {
      del(out, transform.field);

    } else if (op === 'coalesce') {
      const sources = transform.from || [];
      let resolved;
      for (const src of sources) {
        const v = get(out, src);
        if (v != null && v !== '') {
          resolved = v;
          break;
        }
      }
      if (resolved === undefined) resolved = transform.default;
      set(out, transform.out, resolved);

    } else if (op === 'concat') {
      const parts = (transform.parts || []).map((part) => applyRecordTemplates(part, out));
      set(out, transform.out, parts.join(''));
    }
  }

  return out;
}
