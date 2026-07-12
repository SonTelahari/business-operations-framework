const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = __dirname;
loadEnvFile(path.join(root, "..", "discord-bridge", ".env"));
const port = Number(process.env.PORT || 4273);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/health") {
    sendJson(response, {
      ok: true,
      service: "frontier-firearms-still-water-app",
      sheetConfigured: Boolean(process.env.APPS_SCRIPT_URL),
      uptimeSeconds: Math.round(process.uptime())
    });
    return;
  }
  if (url.pathname === "/api/bootstrap") {
    sendJson(response, await getBootstrapData());
    return;
  }
  if (url.pathname === "/api/sync" && request.method === "POST") {
    sendJson(response, await syncGuiPayload(await readJsonBody(request)));
    return;
  }

  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(root, pathname));

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream"
    });
    response.end(data);
  });
});

server.listen(port, () => {
  console.log(`Frontier Firearms - Still Water app running at http://localhost:${port}`);
});

function sendJson(response, payload) {
  response.writeHead(payload.ok === false ? 503 : 200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise(resolve => {
    let body = "";
    request.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
    request.on("error", () => resolve({}));
  });
}

async function getBootstrapData() {
  const data = readCatalogFiles();
  const sheetSnapshot = await readSheetSnapshot();
  return {
    source: sheetSnapshot ? "apps-script-and-local-app-files" : "local-app-files",
    generatedAt: new Date().toISOString(),
    sheetConfigured: Boolean(process.env.APPS_SCRIPT_URL),
    sheet: sheetSnapshot,
    categories: data.categories,
    items: data.items,
    recipeCount: Object.keys(data.recipes).length,
    recipes: data.recipes,
    syncTargets: {
      stockCounts: "/api/sync",
      manualMovements: "/api/sync",
      ledgerAdjustments: "/api/sync",
      stockTargets: "/api/sync",
      timeClock: "/api/sync"
    }
  };
}

async function readSheetSnapshot() {
  if (!process.env.APPS_SCRIPT_URL) return null;

  try {
    const url = new URL(process.env.APPS_SCRIPT_URL);
    url.searchParams.set("action", "bootstrap");
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return { ok: false, error: `Apps Script ${response.status}` };
    const text = await response.text();
    return parseJsonText(text) || { ok: false, error: "Apps Script returned a non-JSON response" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function syncGuiPayload(payload) {
  if (!process.env.APPS_SCRIPT_URL) {
    return {
      ok: false,
      localOnly: true,
      error: "APPS_SCRIPT_URL is not configured"
    };
  }

  try {
    const response = await fetch(process.env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        source: "frontier-gui",
        ...payload
      }),
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    const result = parseJsonText(text);
    if (!response.ok) return { ok: false, error: `Apps Script ${response.status}`, body: text };
    if (!result) return { ok: false, error: "Apps Script returned a non-JSON response" };
    return result;
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

function readCatalogFiles() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "items.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "recipes.js"), "utf8"), context);
  return {
    categories: context.window.FRONTIER_CATEGORIES || [],
    items: context.window.FRONTIER_ITEMS || [],
    recipes: context.window.FRONTIER_RECIPES || {}
  };
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function parseJsonText(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return null;
  }
}
