"use strict";

/**
 * Minimal fetch wrapper using Node 18+ global fetch.
 * Keeps dependencies small (no axios) and is sufficient for integration tests.
 */

/**
 * PUBLIC_INTERFACE
 * Perform an HTTP JSON request and return status + parsed body (if any).
 *
 * @param {string} url
 * @param {{
 *  method?: string,
 *  headers?: Record<string, string>,
 *  body?: any,
 *  timeoutMs?: number
 * }} options
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: any }>}
 */
async function httpJson(url, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };

  /** @type {AbortController | undefined} */
  let controller;
  /** @type {NodeJS.Timeout | undefined} */
  let timeout;
  if (options.timeoutMs && Number.isFinite(options.timeoutMs)) {
    controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  }

  let body;
  if (options.body !== undefined) {
    headers["content-type"] = headers["content-type"] || "application/json";
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller ? controller.signal : undefined,
    });

    const outHeaders = {};
    res.headers.forEach((v, k) => {
      outHeaders[k.toLowerCase()] = v;
    });

    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        parsed = text;
      }
    }

    return { status: res.status, headers: outHeaders, body: parsed };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

module.exports = { httpJson };
