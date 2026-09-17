/**
 * The JSON value contract for this package.
 *
 * `unknown` and `Record<string, unknown>` say nothing about what a value may
 * hold, so anything that reads them has to assert. These types say exactly what
 * a decoded JSON document can be, which is both more informative and enough for
 * the linter's dictionary and unknown-parameter rules.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | JsonObject;

/**
 * An object on its way to `JSON.stringify`. The index signature admits `undefined`
 * because a key whose value is `undefined` is dropped during serialization, so an
 * optional field and an absent one are the same thing on the wire.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

/**
 * A value as it reaches a response projector. Wider than `JsonValue` on purpose:
 * `undefined` and array holes are admitted because the projectors are total by
 * contract and are exercised against malformed input, even though `JSON.parse`
 * itself never produces either.
 */
export type JsonInput = JsonValue | undefined | readonly JsonInput[];

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `JSON.stringify` with object keys sorted at every depth, so two documents that
 * differ only in key order serialize identically. Array order is preserved,
 * because array order is data.
 *
 * Used for cache-key derivation: without it, reordering a property in a request
 * body literal silently churns every shared cache entry for that endpoint.
 */
export function stableJson(value: JsonValue | undefined): string {
  return JSON.stringify(sortKeys(value ?? null));
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);

  if (!isJsonObject(value)) return value;
  const sorted: Record<string, JsonValue> = {};

  for (const key of Object.keys(value).sort()) {
    const entry = value[key];

    if (entry !== undefined) sorted[key] = sortKeys(entry);
  }

  return sorted;
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number";
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === "boolean";
}
