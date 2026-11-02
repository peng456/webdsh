// "zod/v4/core" does not import the classic layer that made the graph cyclic.
import * as core from "./v4/core/index.js";

const shapeDef = (shape) => ({ type: "object", shape });

/**
 * Give the object schema the accessor zod's classic layer has: reading a key
 * name off the schema yields that entry. They are non-enumerable, so module
 * interop and `Object.assign` never try to copy — or write — them; a shape key
 * named "url" or "name" would otherwise collide with the copy machinery.
 */
function attach(node, members) {
	if (members === undefined) return node;
	for (const key of Object.keys(members)) {
		Object.defineProperty(node, key, { get: () => members[key], enumerable: false, configurable: true });
	}
	return node;
}

/**
 * A schema carrying zod's own definition object, and the chainable modifiers
 * this build's plugins use. A modifier returns a new schema with the same
 * members, so \`z.object(shape).describe(…).array()\` keeps its shape.
 */
function schema(def, members) {
	const node = attach({ _zod: { def }, def }, members);
	const make = (nextDef) => schema(nextDef, members);
	const none = () => make(def);
	const check = () => make(def);
	Object.assign(node, {
		// These change what a value may be, so they record it rather than
		// returning the schema unchanged: `review: z.object({…}).optional()`
		// must accept a missing key.
		optional: () => make({ type: "optional", inner: def }),
		nullable: () => make({ type: "nullable", inner: def }),
		default: (value) => make({ type: "default", inner: def, value }),
		describe: none,
		catch: none,
		// A check records what was asked for and returns the schema unchanged:
		// consumers read the definition object, and a constraint not enforced
		// here is still the constraint zod declared.
		min: check, max: check, length: check, regex: check, email: check,
		toURL: check, uuid: check, datetime: check, startsWith: check,
		endsWith: check, includes: check, trim: check, toLowerCase: check,
		toUpperCase: check, int: check, positive: check, nonnegative: check,
		negative: check, nonempty: check,
		// Refinements run at parse time, which a definition-only shim never
		// reaches; they keep the schema so the chain composes.
		superRefine: check, refine: check, transform: check, pipe: check,
		strict: check, passthrough: check, strip: check, catchall: check,
		partial: check, required: check, extend: check, merge: check,
		array: () => make({ type: "array", element: node }),
		// The runtime half of zod: a schema you can actually check a value with.
		parse: (value) => validate(def, value, ''),
		safeParse: (value) => {
			try { return { success: true, data: validate(def, value, '') }; }
			catch (error) { return { success: false, error }; }
		},
		parseAsync: async (value) => validate(def, value, ''),
		safeParseAsync: async (value) => {
			try { return { success: true, data: validate(def, value, '') }; }
			catch (error) { return { success: false, error }; }
		},
	});
	// Deliberately no `shape` property: the definition object already carries
	// it, and a second one would be a getter-only field for interop to trip on.
	return node;
}

/**
 * Validate a value against a recorded definition, the way `schema.parse` does.
 *
 * The definitions are the ones zod would have built, so this is a small
 * interpreter over them rather than a second schema language. It enforces what
 * the schemas here actually use — required fields, primitive types, enums,
 * arrays, records and unions — and throws a ZodError-shaped object on a miss.
 */
function validate(node, value, path) {
	// A schema, not a definition: unwrap it. Nested members are always schemas.
	const def = node !== null && typeof node === "object" && node.def !== undefined ? node.def : node;
	const fail = (message) => {
		const error = new Error(`${path || '<root>'}: ${message}`);
		error.name = 'ZodError';
		error.issues = [{ code: 'invalid_type', path: path.split('.').filter(Boolean), message }];
		throw error;
	};
	switch (def.type) {
		case 'string': return typeof value === 'string' ? value : fail('expected string');
		case 'number': return typeof value === 'number' && !Number.isNaN(value) ? value : fail('expected number');
		case 'boolean': return typeof value === 'boolean' ? value : fail('expected boolean');
		case 'bigint': return typeof value === 'bigint' ? value : fail('expected bigint');
		case 'undefined': return value === undefined ? value : fail('expected undefined');
		case 'null': return value === null ? value : fail('expected null');
		case 'any': case 'unknown': return value;
		case 'optional': return value === undefined ? undefined : validate(def.inner, value, path);
		case 'nullable': return value === null ? null : validate(def.inner, value, path);
		case 'default': return value === undefined ? validate(def.inner, def.value, path) : validate(def.inner, value, path);
		case 'literal': return def.values.includes(value) ? value : fail('invalid literal');
		case 'enum': return def.entries.some(([, entry]) => entry === value) ? value : fail('invalid enum value');
		case 'array': {
			if (!Array.isArray(value)) fail('expected array');
			return value.map((item, index) => validate(def.element, item, `${path}.${String(index)}`));
		}
		case 'record': {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('expected object');
			const out = {};
			for (const [key, item] of Object.entries(value)) out[key] = validate(def.valueType, item, `${path}.${key}`);
			return out;
		}
		case 'object': {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('expected object');
			const out = {};
			for (const [key, member] of Object.entries(def.shape)) {
				const result = validate(member, value[key], `${path}.${key}`);
				if (result !== undefined) out[key] = result;
			}
			return out;
		}
		case 'union': {
			for (const option of def.options) {
				try { return validate(option, value, path); } catch { /* next */ }
			}
			return fail('no union member matched');
		}
		case 'intersection': return { ...validate(def.left, value, path), ...validate(def.right, value, path) };
		case 'tuple': return Array.isArray(value) ? def.items.map((item, index) => validate(item, value[index], `${path}.${String(index)}`)) : fail('expected tuple');
		default: return value;
	}
}

export const z = {
	string: () => schema({ type: "string" }),
	number: () => schema({ type: "number" }),
	boolean: () => schema({ type: "boolean" }),
	bigint: () => schema({ type: "bigint" }),
	undefined: () => schema({ type: "undefined" }),
	null: () => schema({ type: "null" }),
	any: () => schema({ type: "any" }),
	unknown: () => schema({ type: "unknown" }),
	array: (element) => schema({ type: "array", element }),
	object: (shape) => schema(shapeDef(shape), shape),
	record: (keyType, valueType) => schema({ type: "record", keyType, valueType }),
	enum: (options) => schema({ type: "enum", entries: options.map((value, index) => [String(index), value]) }),
	literal: (value) => schema({ type: "literal", values: [value] }),
	union: (options) => schema({ type: "union", options }),
	discriminatedUnion: (discriminator, options) => schema({ type: "union", options, discriminator }),
	intersection: (left, right) => schema({ type: "intersection", left, right }),
	tuple: (items) => schema({ type: "tuple", items }),
};

export { core };
export default z;
