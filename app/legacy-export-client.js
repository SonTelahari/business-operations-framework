const { createLegacyBusinessArchive } = require("./business-archive");

async function exportLegacyBusiness({
  appUrl,
  fullName,
  password,
  business = {},
  materialCosts = {},
  productPrices = {},
  fetchImpl = fetch
}) {
  const baseUrl = normalizeBaseUrl(appUrl);
  if (!baseUrl) throw exportError("Set the HTTPS URL of the current hosted app", "legacy_app_url_required");
  if (!String(fullName || "").trim() || !String(password || "")) {
    throw exportError("Legacy admin character name and password are required", "legacy_credentials_required");
  }
  const loginResponse = await fetchImpl(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ fullName, password }),
    signal: AbortSignal.timeout(30000)
  });
  const login = await readJson(loginResponse, "Legacy login");
  if (!loginResponse.ok || !login?.ok) {
    throw exportError(login?.error || "Legacy login failed", login?.code || "legacy_login_failed");
  }
  const cookie = sessionCookie(loginResponse.headers);
  if (!cookie) throw exportError("Legacy login did not return a session cookie", "legacy_session_missing");
  const request = path => fetchJson(fetchImpl, `${baseUrl}${path}`, cookie);
  const [bootstrap, suppliersResponse, supplyOrdersResponse, usersResponse, auditResponse] = await Promise.all([
    request("/api/bootstrap"),
    request("/api/suppliers"),
    request("/api/supply-orders"),
    request("/api/admin/users"),
    request("/api/admin/audit?limit=1000")
  ]);
  const warnings = [];
  let customers = [];
  try {
    const customersResponse = await request("/api/customers");
    customers = Array.isArray(customersResponse.customers) ? customersResponse.customers : [];
  } catch (error) {
    warnings.push(`Customer export warning: ${error.message}`);
  }
  let finance = null;
  try {
    finance = await request("/api/finance");
  } catch (error) {
    warnings.push(`Finance export warning: ${error.message}`);
  }
  return createLegacyBusinessArchive({
    bootstrap,
    customers,
    suppliers: suppliersResponse.suppliers,
    supplyOrders: supplyOrdersResponse.orders,
    users: usersResponse.users,
    audit: auditResponse.events,
    finance,
    source: { system: "frontier-firearms-still-water", url: baseUrl },
    business,
    materialCosts,
    productPrices,
    warnings
  });
}

async function fetchJson(fetchImpl, url, cookie) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", cookie },
    signal: AbortSignal.timeout(60000)
  });
  const result = await readJson(response, new URL(url).pathname);
  if (!response.ok || result?.ok === false) {
    throw exportError(result?.error || `Legacy request failed (${response.status})`, result?.code || "legacy_request_failed");
  }
  return result;
}

async function readJson(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw exportError(`${label} returned non-JSON content`, "legacy_non_json_response");
  }
}

function sessionCookie(headers) {
  const entries = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  const value = entries[0] || headers.get("set-cookie") || "";
  return String(value).split(";", 1)[0].trim();
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return "";
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}`;
  } catch {
    return "";
  }
}

function exportError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  exportLegacyBusiness,
  normalizeBaseUrl,
  sessionCookie
};
