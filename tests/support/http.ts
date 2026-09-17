import http from "node:http";

import type { JsonValue } from "../../src/json.js";
import { parseJsonObject } from "./json.js";
import { sseData } from "./net.js";

export interface RawResponse {
  status: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: JsonValue,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const requestHeaders = { ...headers };

    if (data !== undefined) {
      requestHeaders["content-type"] = "application/json";
      requestHeaders["content-length"] = String(Buffer.byteLength(data));
    }

    const request = http.request(
      { host: "127.0.0.1", port, path, method, headers: requestHeaders },
      (response) => {
        let responseBody = "";
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: responseBody,
          }),
        );
      },
    );

    request.on("error", reject);

    if (data !== undefined) request.write(data);
    request.end();
  });
}

export function jsonRpcObject(raw: string) {
  const payload = raw.includes("data:") ? sseData(raw) : raw.trim();

  return parseJsonObject(payload, "JSON-RPC response");
}
