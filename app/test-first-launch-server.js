const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const port = 4287;
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "business-first-launch-"));
const environment = {
  ...process.env,
  PORT: String(port),
  AUTH_DATA_DIR: dataDirectory,
  AUTH_SESSION_SECRET: "first-launch-test-secret-with-enough-entropy-123456789",
  ADMIN_FULL_NAME: "",
  ADMIN_PASSWORD: "",
  APPS_SCRIPT_URL: "",
  NODE_ENV: "test"
};

let server = startServer();

run().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  server.kill();
  await fs.promises.rm(dataDirectory, { recursive: true, force: true });
});

async function run() {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/health`);

  const health = await getJson(`${baseUrl}/health`);
  assert.equal(health.response.status, 200);
  assert.equal(health.body.setupRequired, true);
  assert.equal(health.body.authMode, "accounts");

  const root = await fetch(baseUrl, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/setup.html");

  const status = await getJson(`${baseUrl}/api/setup/status`);
  assert.equal(status.body.ownerAccountExists, false);
  assert.equal(status.body.defaults.locations.length, 2);

  const setup = await post(`${baseUrl}/api/setup/complete`, {
    owner: { fullName: "Test Owner", password: "OwnerPassword123!" },
    configuration: {
      business: {
        name: "Copper & Pine",
        ledgerName: "Copper & Pine Ledger",
        location: "Blackwater",
        currency: "USD",
        locale: "en-US",
        timezone: "America/New_York"
      },
      locations: [
        { name: "Showroom", type: "sales" },
        { name: "Warehouse", type: "storage" }
      ],
      modules: { discord: true },
      catalog: {
        materials: [{ name: "Copper", category: "Metals", unit: "bar", unitCost: 2.5 }],
        products: [{ name: "Copper Pan", label: "Copper Pan", category: "Cookware", salePrice: 15, target: 4 }],
        recipes: [{ productName: "Copper Pan", yield: 1, ingredients: [{ name: "Copper", quantity: 3 }] }]
      }
    }
  });
  assert.equal(setup.response.status, 201);
  assert.equal(setup.body.business.name, "Copper & Pine");
  const cookie = sessionCookie(setup.response);

  const bootstrap = await getJson(`${baseUrl}/api/bootstrap`, cookie);
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.body.business.ledgerName, "Copper & Pine Ledger");
  assert.equal(bootstrap.body.items[0].name, "Copper Pan");
  assert.deepEqual(bootstrap.body.recipes["Copper Pan"], [["Copper", 3]]);
  assert.equal(bootstrap.body.pricing.materials.Copper.midpoint, 2.5);

  const repeatedSetup = await post(`${baseUrl}/api/setup/complete`, {}, cookie);
  assert.equal(repeatedSetup.response.status, 409);
  assert.equal(repeatedSetup.body.code, "setup_already_completed");

  server.kill();
  await waitForExit(server);
  server = startServer();
  await waitForServer(`${baseUrl}/health`);

  const restartedHealth = await getJson(`${baseUrl}/health`);
  assert.equal(restartedHealth.body.setupRequired, false);
  const publicConfig = await getJson(`${baseUrl}/api/public/config`);
  assert.equal(publicConfig.body.configured, true);
  assert.equal(publicConfig.body.business.name, "Copper & Pine");
  const persistedBootstrap = await getJson(`${baseUrl}/api/bootstrap`, cookie);
  assert.equal(persistedBootstrap.response.status, 200);
  assert.equal(persistedBootstrap.body.items[0].target, 4);

  console.log("First-launch owner, business catalog, and restart persistence checks passed.");
}

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", chunk => process.stderr.write(chunk));
  return child;
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Test server did not start");
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once("exit", resolve));
}

async function getJson(url, cookie = "") {
  const response = await fetch(url, { headers: { accept: "application/json", ...(cookie ? { cookie } : {}) } });
  return { response, body: await response.json() };
}

async function post(url, payload, cookie = "") {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload)
  });
  return { response, body: await response.json() };
}

function sessionCookie(response) {
  const value = response.headers.get("set-cookie") || "";
  assert.match(value, /^business_session=/);
  return value.split(";", 1)[0];
}
