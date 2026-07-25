// validate.mjs — hold the model to the schema it declares. Shared by `gen` (after write) and `check`.

// Zero deps (ADR-0001), so the engine is a hand-written walker over the ONLY keywords the
// shipped lib/schema/c4-model.schema.json uses:
//   type (object|array|string|integer|number|boolean|null), required, properties,
//   additionalProperties (enforced only where it is literally false), items (single schema, no
//   tuple form), enum, minItems, minimum, maximum, pattern.
// Annotation-only keywords are read and deliberately NOT enforced: $schema, $id, title,
// description, default, format — `format: "date-time"`/`"uri"` are not checked, exactly as ajv
// without ajv-formats treats them in draft-07.
// This is NOT a general JSON Schema engine. A third-party schema using oneOf/allOf/$ref/
// patternProperties/tuple items/dependencies would be silently UNDER-validated: the unknown
// keyword is ignored, never an error. Widen this file before pointing it at another schema.
import { readFileSync } from 'node:fs'

const typeIsObject = (v) => v !== null && !Array.isArray(v) && typeof v === 'object'
const jsType = (v) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
const typeOk = (value, type) => {
  if (type === 'object') return typeIsObject(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number'
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'null') return value === null
  return true
}
const formatTypeError = (path, expected, value) => path + ': expected ' + expected + ', got ' + jsType(value)
const childPath = (path, key) => (path === '<root>' ? key : path + '.' + key)
const enumText = (set) => set.map((v) => typeof v === 'string' ? v : String(v)).join(', ')
const validateAgainstSchema = (value, schema, path, errs) => {
  const declared = schema.type || null
  if (declared && !typeOk(value, declared)) { errs.push(formatTypeError(path, declared, value)); return }
  if (schema.required && typeIsObject(value)) {
    for (const key of schema.required) if (!Object.prototype.hasOwnProperty.call(value, key)) errs.push(path + ': missing required property "' + key + '"')
  }
  if (schema.properties && typeIsObject(value)) {
    for (const [k, s] of Object.entries(schema.properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue
      validateAgainstSchema(value[k], s, childPath(path, k), errs)
    }
  }
  if (schema.additionalProperties === false && typeIsObject(value)) {
    for (const key of Object.keys(value)) if (!schema.properties || !Object.prototype.hasOwnProperty.call(schema.properties, key)) errs.push(path + ': unexpected property "' + key + '" (additionalProperties: false)')
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    value.forEach((item, i) => validateAgainstSchema(item, schema.items, path + '[' + i + ']', errs))
  }
  // outside the items branch on purpose: minItems constrains the array, not its element schema
  if (schema.minItems != null && Array.isArray(value) && value.length < schema.minItems) errs.push(path + ': expected at least ' + schema.minItems + ' item, got ' + value.length)
  if (schema.enum && schema.enum.includes(value) === false) {
    const expected = enumText(schema.enum)
    errs.push(path + ': ' + JSON.stringify(value) + ' is not one of [' + expected + ']')
  }
  if (schema.minimum != null && typeof value === 'number' && value < schema.minimum) errs.push(path + ': ' + value + ' is less than the minimum ' + schema.minimum)
  if (schema.maximum != null && typeof value === 'number' && value > schema.maximum) errs.push(path + ': ' + value + ' is greater than the maximum ' + schema.maximum)
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) errs.push(path + ': ' + JSON.stringify(value) + ' does not match ' + schema.pattern)
}

export const validateModel = (model, schemaPath = new URL('./schema/c4-model.schema.json', import.meta.url)) => {
  let schema
  try { schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) } catch (e) { return ['<root>: unable to read schema - ' + String((e && e.message) || e)] }
  const errs = []
  validateAgainstSchema(model, schema, '<root>', errs)
  return errs
}
