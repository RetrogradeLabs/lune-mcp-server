import {
  isJsonBoolean,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
} from "../../src/json.js";

export function parseJson(raw: string): JsonValue {
  return JSON.parse(raw);
}

export function parseJsonObject(raw: string, label = "JSON body"): JsonObject {
  return jsonObject(parseJson(raw), label);
}

export async function fetchJsonObject(
  response: Response,
  label = "response body",
): Promise<JsonObject> {
  return parseJsonObject(await response.text(), label);
}

export function jsonObject(
  value: JsonValue | undefined,
  label = "value",
): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${label} is not a JSON object`);

  return value;
}

export function jsonArray(
  value: JsonValue | undefined,
  label = "value",
): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not a JSON array`);

  return value;
}

export function jsonString(
  value: JsonValue | undefined,
  label = "value",
): string {
  if (!isJsonString(value)) throw new Error(`${label} is not a string`);

  return value;
}

export function jsonNumber(
  value: JsonValue | undefined,
  label = "value",
): number {
  if (!isJsonNumber(value)) throw new Error(`${label} is not a number`);

  return value;
}

export function jsonBoolean(
  value: JsonValue | undefined,
  label = "value",
): boolean {
  if (!isJsonBoolean(value)) throw new Error(`${label} is not a boolean`);

  return value;
}

export function jsonObjects(
  value: JsonValue | undefined,
  label = "value",
): JsonObject[] {
  return jsonArray(value, label).map((entry, index) =>
    jsonObject(entry, `${label}[${index}]`),
  );
}

export function jsonStrings(
  value: JsonValue | undefined,
  label = "value",
): string[] {
  return jsonArray(value, label).map((entry, index) =>
    jsonString(entry, `${label}[${index}]`),
  );
}
