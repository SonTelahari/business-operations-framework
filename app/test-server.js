const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const port = 4283;
const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
  env: {
    ...process.env,
    PORT: String(port),
    APPS_SCRIPT_URL: "",
    APP_AUTH_USER: "frontier-test",
    APP_AUTH_PASSWORD: "correct-horse"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
server.stderr.on("data", chunk => { stderr += chunk; });

run().catch(error => {
  console.error(error.stack || error.message);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
}).finally(() => {
  server.kill();
});

async function run() {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/health`);

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).authConfigured, true);

  const unauthenticated = await fetch(baseUrl, { redirect: "manual" });
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get("www-authenticate") || "", /^Basic /);

  const wrong = await fetch(baseUrl, {
    headers: { authorization: basic("frontier-test", "wrong") }
  });
  assert.equal(wrong.status, 401);

  const authenticated = await fetch(baseUrl, {
    headers: { authorization: basic("frontier-test", "correct-horse") }
  });
  assert.equal(authenticated.status, 200);
  assert.match(await authenticated.text(), /Frontier Firearms/);

  console.log("App server health and Basic Auth checks passed.");
}

function basic(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function waitForServer(url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for app server test process.");
}
