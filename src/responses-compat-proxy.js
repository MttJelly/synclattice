const http = require("node:http");

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

function unsupportedSearchTool(message, toolType) {
  const text = String(message || "");
  return text.toLowerCase().includes(String(toolType || "").toLowerCase())
    && /(?:unsupported|not supported|unknown|invalid)[^\r\n]{0,80}(?:tool|type)|(?:tool|type)[^\r\n]{0,80}(?:unsupported|not supported|unknown|invalid)/i.test(text);
}

function rewriteSearchTool(body, fromType, toType = null) {
  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body || ""));
  } catch {
    return null;
  }
  if (!Array.isArray(payload.tools)) return null;
  let changed = false;
  payload.tools = payload.tools.flatMap((tool) => {
    if (!tool || tool.type !== fromType) return [tool];
    changed = true;
    return toType ? [{ ...tool, type: toType }] : [];
  });
  return changed ? Buffer.from(JSON.stringify(payload), "utf8") : null;
}

function requestHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) result[name] = value;
  }
  return result;
}

function responseHeaders(headers) {
  const result = {};
  headers?.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) result[name] = value;
  });
  return result;
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error("Responses request exceeds the local proxy limit."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function sendResponse(target, upstream, bufferedBody = null) {
  target.writeHead(upstream.status, upstream.statusText, responseHeaders(upstream.headers));
  if (bufferedBody !== null) {
    target.end(bufferedBody);
    return;
  }
  if (!upstream.body) {
    target.end();
    return;
  }
  try {
    for await (const chunk of upstream.body) target.write(Buffer.from(chunk));
    target.end();
  } catch (error) {
    target.destroy(error);
  }
}

async function startResponsesCompatibilityProxy({ baseUrl, fetchImpl = globalThis.fetch, onFallback = null }) {
  if (typeof fetchImpl !== "function") throw new Error("Responses compatibility proxy requires fetch support.");
  const upstreamBase = new URL(String(baseUrl || "").trim());
  if (!["http:", "https:"].includes(upstreamBase.protocol)) throw new Error("Responses upstream URL is invalid.");
  const allowedPath = upstreamBase.pathname.replace(/\/+$/, "");
  const notifiedFallbacks = new Set();
  const notifyFallback = (mode) => {
    if (notifiedFallbacks.has(mode)) return;
    notifiedFallbacks.add(mode);
    onFallback?.(mode);
  };

  const server = http.createServer(async (request, response) => {
    try {
      const incoming = new URL(request.url || "/", "http://127.0.0.1");
      if (allowedPath && incoming.pathname !== allowedPath && !incoming.pathname.startsWith(`${allowedPath}/`)) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      const upstreamUrl = new URL(upstreamBase.origin);
      upstreamUrl.pathname = incoming.pathname;
      upstreamUrl.search = incoming.search;
      const originalBody = await requestBody(request);
      let body = originalBody;
      let upstream;
      let bufferedError = null;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        upstream = await fetchImpl(upstreamUrl, {
          method: request.method,
          headers: requestHeaders(request.headers),
          body: ["GET", "HEAD"].includes(request.method || "") ? undefined : body,
        });
        if (upstream.status !== 400) {
          bufferedError = null;
          break;
        }
        bufferedError = Buffer.from(await upstream.arrayBuffer());
        const errorText = bufferedError.toString("utf8");
        if (unsupportedSearchTool(errorText, "web_search_preview")) {
          const rewritten = rewriteSearchTool(body, "web_search_preview", "web_search");
          if (rewritten) {
            body = rewritten;
            notifyFallback("web_search");
            continue;
          }
        }
        if (unsupportedSearchTool(errorText, "web_search")) {
          const rewritten = rewriteSearchTool(body, "web_search", null);
          if (rewritten) {
            body = rewritten;
            notifyFallback("disabled");
            continue;
          }
        }
        break;
      }
      await sendResponse(response, upstream, bufferedError);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: { message: `ChatSwitch 本地兼容转发失败：${error.message}` } }));
    }
  });

  await new Promise((resolve, reject) => {
    const listening = () => {
      server.off("error", reject);
      resolve();
    };
    server.once("error", reject);
    server.listen(0, "127.0.0.1", listening);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}${allowedPath}`,
    close() {
      server.close();
      server.closeAllConnections?.();
    },
  };
}

module.exports = {
  rewriteSearchTool,
  startResponsesCompatibilityProxy,
  unsupportedSearchTool,
};
