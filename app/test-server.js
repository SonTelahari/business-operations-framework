const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const port = 4283;
const receiverPort = 4282;
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "still-water-auth-"));
const mockReceiver = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  if (request.method === "GET") {
    response.end(JSON.stringify({
      ok: true,
      generatedAt: "2026-07-13T03:30:00.000Z",
      sheets: [{ name: "Products", lastRow: 3 }],
      inventory: {
        products: [
          { itemName: "Navy Revolver", itemLabel: "Navy Revolver", target: 5, currentStock: 1 },
          { itemName: "Boltaction Rifle", itemLabel: "BoltAction Rifle", target: 5, currentStock: 3 }
        ],
        materials: [{ ingredient: "Iron", storageCount: 12 }]
      }
    }));
    return;
  }
  response.end(JSON.stringify({ ok: true }));
});
mockReceiver.listen(receiverPort, "127.0.0.1");
const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
  env: {
    ...process.env,
    PORT: String(port),
    APPS_SCRIPT_URL: `http://127.0.0.1:${receiverPort}/exec`,
    APP_AUTH_USER: "",
    APP_AUTH_PASSWORD: "",
    AUTH_DATA_DIR: dataDirectory,
    AUTH_SESSION_SECRET: "test-session-secret-with-enough-entropy-123456789",
    ADMIN_FULL_NAME: "Frontier Owner",
    ADMIN_PASSWORD: "OwnerPassword123!",
    NODE_ENV: "test"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
server.stderr.on("data", chunk => { stderr += chunk; });

run().catch(error => {
  console.error(error.stack || error.message);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
}).finally(async () => {
  server.kill();
  mockReceiver.close();
  await fs.promises.rm(dataDirectory, { recursive: true, force: true });
});

async function run() {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/health`);

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json().then(result => [result.authMode, result.persistentAccountStore]), ["accounts", true]);

  const loginPage = await fetch(`${baseUrl}/login.html`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Request Access/);

  const unauthenticatedPage = await fetch(baseUrl, { redirect: "manual" });
  assert.equal(unauthenticatedPage.status, 302);
  assert.equal(unauthenticatedPage.headers.get("location"), "/login.html");

  const unauthenticatedApi = await fetch(`${baseUrl}/api/bootstrap`);
  assert.equal(unauthenticatedApi.status, 401);

  const ownerLogin = await post(`${baseUrl}/api/auth/login`, {
    fullName: "Frontier Owner",
    password: "OwnerPassword123!"
  });
  assert.equal(ownerLogin.response.status, 200);
  assert.equal(ownerLogin.body.user.role, "admin");
  const ownerCookie = cookieFrom(ownerLogin.response);

  const authenticatedPage = await fetch(baseUrl, { headers: { cookie: ownerCookie } });
  assert.equal(authenticatedPage.status, 200);
  assert.match(await authenticatedPage.text(), /Employee Accounts/);

  const accountStoreLeak = await fetch(`${baseUrl}/.data/users.json`, { headers: { cookie: ownerCookie } });
  assert.equal(accountStoreLeak.status, 404);
  const serverSourceLeak = await fetch(`${baseUrl}/server.js`, { headers: { cookie: ownerCookie } });
  assert.equal(serverSourceLeak.status, 404);

  const bootstrap = await getJson(`${baseUrl}/api/bootstrap`, ownerCookie);
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.body.sheet.inventory.products[0].currentStock, 1);
  assert.equal(bootstrap.body.sheet.inventory.products[1].target, 5);
  assert.equal(bootstrap.body.sheet.inventory.materials[0].storageCount, 12);

  const registration = await post(`${baseUrl}/api/auth/register`, {
    fullName: "Ada Employee",
    password: "EmployeePassword123!"
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.body.user.status, "pending");

  const duplicate = await post(`${baseUrl}/api/auth/register`, {
    fullName: "  ADA   EMPLOYEE ",
    password: "AnotherPassword123!"
  });
  assert.equal(duplicate.response.status, 409);

  const pendingLogin = await post(`${baseUrl}/api/auth/login`, {
    fullName: "Ada Employee",
    password: "EmployeePassword123!"
  });
  assert.equal(pendingLogin.response.status, 403);
  assert.equal(pendingLogin.body.code, "approval_pending");

  const usersBeforeApproval = await getJson(`${baseUrl}/api/admin/users`, ownerCookie);
  const pendingUser = usersBeforeApproval.body.users.find(user => user.fullName === "Ada Employee");
  assert.equal(pendingUser.status, "pending");

  const approval = await post(`${baseUrl}/api/admin/users/${pendingUser.id}/approve`, {}, ownerCookie);
  assert.equal(approval.response.status, 200);
  assert.equal(approval.body.user.status, "active");

  const employeeLogin = await post(`${baseUrl}/api/auth/login`, {
    fullName: "Ada Employee",
    password: "EmployeePassword123!"
  });
  assert.equal(employeeLogin.response.status, 200);
  const employeeCookie = cookieFrom(employeeLogin.response);

  const employeeSession = await getJson(`${baseUrl}/api/auth/session`, employeeCookie);
  assert.equal(employeeSession.body.user.fullName, "Ada Employee");
  assert.equal(employeeSession.body.user.accountManagement, true);

  const employeeAdminAttempt = await getJson(`${baseUrl}/api/admin/users`, employeeCookie);
  assert.equal(employeeAdminAttempt.response.status, 403);

  const protectedSync = await post(`${baseUrl}/api/sync`, {
    action: "stock_target",
    target: { itemName: "Navy Revolver", target: 2 }
  }, employeeCookie);
  assert.equal(protectedSync.response.status, 403);

  const disabled = await post(`${baseUrl}/api/admin/users/${pendingUser.id}/disable`, {}, ownerCookie);
  assert.equal(disabled.response.status, 200);
  const disabledSession = await getJson(`${baseUrl}/api/auth/session`, employeeCookie);
  assert.equal(disabledSession.body.user, null);

  const accountFile = await fs.promises.readFile(path.join(dataDirectory, "users.json"), "utf8");
  assert.doesNotMatch(accountFile, /OwnerPassword123|EmployeePassword123/);
  assert.match(accountFile, /"algorithm": "scrypt"/);

  const logout = await post(`${baseUrl}/api/auth/logout`, {}, ownerCookie);
  assert.equal(logout.response.status, 200);
  assert.match(logout.response.headers.get("set-cookie") || "", /Max-Age=0/);

  await testLegacyFallback();

  console.log("Personal accounts and safe shared-login migration checks passed.");
}

async function testLegacyFallback() {
  const legacyPort = 4285;
  const legacyServer = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: {
      ...process.env,
      PORT: String(legacyPort),
      APPS_SCRIPT_URL: "",
      AUTH_SESSION_SECRET: "",
      AUTH_DATA_DIR: "",
      ADMIN_FULL_NAME: "",
      ADMIN_PASSWORD: "",
      APP_AUTH_USER: "frontier-legacy",
      APP_AUTH_PASSWORD: "LegacyPassword123!",
      NODE_ENV: "test"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  try {
    const legacyUrl = `http://127.0.0.1:${legacyPort}`;
    await waitForServer(`${legacyUrl}/health`);
    const unauthenticated = await fetch(legacyUrl);
    assert.equal(unauthenticated.status, 401);
    const authorization = `Basic ${Buffer.from("frontier-legacy:LegacyPassword123!").toString("base64")}`;
    const session = await fetch(`${legacyUrl}/api/auth/session`, { headers: { authorization } });
    assert.equal(session.status, 200);
    const result = await session.json();
    assert.equal(result.user.role, "admin");
    assert.equal(result.user.accountManagement, false);
  } finally {
    legacyServer.kill();
  }
}

async function post(url, payload, cookie = "") {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(cookie ? { cookie } : {})
    },
    body: JSON.stringify(payload)
  });
  return { response, body: await response.json() };
}

async function getJson(url, cookie = "") {
  const response = await fetch(url, {
    headers: { accept: "application/json", ...(cookie ? { cookie } : {}) }
  });
  return { response, body: await response.json() };
}

function cookieFrom(response) {
  const value = response.headers.get("set-cookie") || "";
  assert.match(value, /^ff_session=/);
  return value.split(";", 1)[0];
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
