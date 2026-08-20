const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { AsyncLocalStorage } = require("node:async_hooks");
const { AccountStore, SESSION_MAX_AGE_SECONDS, readSessionIdentity } = require("./auth");
const { BusinessStore } = require("./business-store");
const { Database, PostgresDocumentRepository } = require("./database");
const {
  DiscordIdentityStore,
  IDENTITY_SESSION_MAX_AGE_SECONDS,
  MEMBERSHIP_SESSION_MAX_AGE_SECONDS
} = require("./discord-identity");
const { StandaloneStore } = require("./standalone-store");
const {
  LocalIdentityStore,
  LOCAL_IDENTITY_SESSION_MAX_AGE_SECONDS
} = require("./local-identity");
const { defaultSetupConfiguration, normalizeSetupPayload } = require("./setup-config");
const { TenantManager, normalizeWorkspaceCode } = require("./tenant-manager");
const { PlatformOperations } = require("./platform-operations");
const { planProduction } = require("./production-planner");
const productionInventory = require("./production-inventory");

const root = __dirname;
loadEnvFile(path.join(root, "..", ".env"));
loadEnvFile(path.join(root, "..", "discord-bridge", ".env"));
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "..", "package.json"), "utf8")).version;
const releaseVersion = String(
  process.env.APP_RELEASE
  || process.env.RAILWAY_DEPLOYMENT_ID
  || process.env.RAILWAY_GIT_COMMIT_SHA
  || packageVersion
).slice(0, 120);
const ORDER_PRODUCTION_SOURCE_TYPES = new Set(["Customer Order", "Internal Craft"]);
const port = Number(process.env.PORT || 4273);
const authUser = process.env.APP_AUTH_USER || "frontier";
const authPassword = process.env.APP_AUTH_PASSWORD || "";
const accountDataDirectory = process.env.AUTH_DATA_DIR
  || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || path.join(root, ".data");
const database = new Database({ connectionString: process.env.DATABASE_URL || "" });
const hostedMode = database.enabled && process.env.HOSTED_MODE === "1";
const hostedSignupMode = resolveHostedSignupMode(process.env.HOSTED_SIGNUP_MODE);
const sessionSecretState = database.enabled
  ? { value: process.env.AUTH_SESSION_SECRET || "", persistent: Boolean(process.env.AUTH_SESSION_SECRET) }
  : resolveSessionSecret(accountDataDirectory, process.env.AUTH_SESSION_SECRET || "");
const sessionSecret = sessionSecretState.value;
const accountAuthEnabled = true;
const tenantRequestContext = new AsyncLocalStorage();
const defaultContext = {
  businessId: "primary",
  business: null,
  accountStore: new AccountStore({
    filePath: path.join(accountDataDirectory, "users.json"),
    sessionSecret,
    businessId: "primary",
    repository: database.enabled ? new PostgresDocumentRepository(database, "accounts") : null
  }),
  businessStore: new BusinessStore({
    filePath: path.join(accountDataDirectory, "business.json"),
    repository: database.enabled ? new PostgresDocumentRepository(database, "business") : null
  }),
  standaloneStore: database.enabled ? new StandaloneStore(database) : null
};
const tenantManager = hostedMode ? new TenantManager({ database, sessionSecret }) : null;
const platformOperations = hostedMode ? new PlatformOperations({
  database,
  secret: process.env.PLATFORM_ADMIN_SECRET || ""
}) : null;
const discordIdentityStore = hostedMode ? new DiscordIdentityStore({
  database,
  sessionSecret,
  clientId: process.env.DISCORD_CLIENT_ID || "",
  clientSecret: process.env.DISCORD_CLIENT_SECRET || "",
  redirectUri: process.env.DISCORD_REDIRECT_URI || "",
  apiBaseUrl: process.env.DISCORD_API_BASE_URL || "https://discord.com/api/v10",
  authorizeUrl: process.env.DISCORD_AUTHORIZE_URL || "https://discord.com/oauth2/authorize"
}) : null;
const localIdentityStore = hostedMode ? new LocalIdentityStore({
  database,
  tenantManager,
  sessionSecret
}) : null;
const accountStore = contextualStore("accountStore");
const businessStore = contextualStore("businessStore");
const standaloneStore = database.enabled ? contextualStore("standaloneStore") : null;
const loginAttempts = new Map();
let supplyReceiptQueue = Promise.resolve();
let productionCreateQueue = Promise.resolve();
let productionProgressQueue = Promise.resolve();
let setupQueue = Promise.resolve();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};
const publicFiles = new Set([
  "/index.html",
  "/login.html",
  "/profile.html",
  "/setup.html",
  "/operator.html",
  "/styles.css",
  "/app.js",
  "/login.js",
  "/profile.js",
  "/setup.js",
  "/operator.js",
  "/pwa.js",
  "/service-worker.js",
  "/manifest.webmanifest",
  "/pricing.js",
  "/items.js",
  "/recipes.js",
  "/production-planner.js",
  "/production-inventory.js",
  "/supply-telegram.js",
  "/inventory-counts.js",
  "/assets/frontier-firearms-logo.png",
  "/assets/counter-gunsmith.jpg",
  "/assets/counter-tobacconist.jpg",
  "/assets/counter-saloon.jpg",
  "/assets/ledger-oxblood-leather.jpg",
  "/assets/operations-ledger-32.png",
  "/assets/operations-ledger-192.png",
  "/assets/operations-ledger-512.png",
  "/assets/operations-ledger-maskable-512.png"
]);

const server = http.createServer((request, response) => {
  dispatchRequest(request, response).catch(error => {
    console.error("App request failed:", error);
    if (!response.headersSent) sendJson(response, { ok: false, error: "The request could not be completed" }, 500);
    else response.end();
  });
});

async function dispatchRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (hostedMode) return dispatchHostedRequest(request, response, url);
  return tenantRequestContext.run(defaultContext, () => handleApplicationRequest(request, response, url));
}

async function handleApplicationRequest(request, response, url) {
  try {
    if (isPublicPwaAsset(url.pathname)) {
      serveStatic(response, url.pathname);
      return;
    }
    if (url.pathname === "/health/data" || url.pathname === "/health/sheet") {
      const snapshot = await readSheetSnapshot();
      const inventory = snapshot?.inventory;
      sendJson(response, {
        ok: Boolean(snapshot?.ok),
        error: snapshot?.error || "",
        schemaVersion: snapshot?.schemaVersion || null,
        dataBackend: standaloneStore ? "postgresql" : "apps-script",
        generatedAt: snapshot?.generatedAt || "",
        inventoryFields: inventory && typeof inventory === "object" ? Object.keys(inventory) : [],
        ledgerAvailable: Number.isFinite(Number(inventory?.ledger?.balance))
      });
      return;
    }
    if (url.pathname === "/health") {
      sendJson(response, {
        ok: true,
        service: "business-operations-framework",
        version: packageVersion,
        release: releaseVersion,
        setupRequired: !businessStore.isConfigured(),
        dataBackend: standaloneStore ? "postgresql" : "apps-script",
        databaseConfigured: database.enabled,
        databaseReady: database.enabled,
        sheetConfigured: !standaloneStore && Boolean(process.env.APPS_SCRIPT_URL),
        bridgeApiConfigured: Boolean(process.env.BRIDGE_API_TOKEN),
        authConfigured: accountAuthEnabled || Boolean(authPassword),
        authMode: accountAuthEnabled ? "accounts" : authPassword ? "legacy-basic" : "none",
        persistentAccountStore: database.enabled || Boolean(process.env.AUTH_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
        persistentSessionSecret: sessionSecretState.persistent,
        persistentBusinessStore: database.enabled || Boolean(process.env.AUTH_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
        supplyReceipts: true,
        storefrontBuyOrders: true,
        webhookReview: true,
        productionBatches: true,
        sharedSalesOrders: true,
        dailyCloses: true,
        financeReporting: true,
        productInsights: true,
        uptimeSeconds: Math.round(process.uptime())
      });
      return;
    }

    if (url.pathname === "/api/public/config" && request.method === "GET") {
      const configuration = businessStore.getConfiguration();
      sendJson(response, {
        ok: true,
        configured: businessStore.isConfigured(),
        business: configuration?.business || null,
        terminology: configuration?.terminology || null
      });
      return;
    }

    if (url.pathname === "/api/setup/status" && request.method === "GET") {
      sendJson(response, {
        ok: true,
        setupRequired: !businessStore.isConfigured(),
        ownerAccountExists: accountStore.hasUsers(),
        defaults: businessStore.isConfigured() ? null : defaultSetupConfiguration()
      });
      return;
    }
    if (businessStore.isConfigured() && url.pathname === "/api/setup/complete") {
      sendJson(response, {
        ok: false,
        error: "Business setup has already been completed",
        code: "setup_already_completed"
      }, 409);
      return;
    }

    if (!businessStore.isConfigured()) {
      if (await handleSetupRoute(request, response, url)) return;
      if (url.pathname.startsWith("/api/")) {
        sendJson(response, { ok: false, error: "First-launch setup is required", code: "setup_required" }, 428);
      } else {
        redirect(response, "/setup.html");
      }
      return;
    }
    if (url.pathname === "/setup.html") {
      redirect(response, "/");
      return;
    }

    if (await handleDiscordIntegrationRoute(request, response, url)) return;

    if (accountAuthEnabled) {
      const user = currentTenantContext().authenticatedUser
        || accountStore.verifySession(readCookie(request, "business_session"));
      if (await handleAccountRoute(request, response, url, user)) return;
      if (!user) {
        if (url.pathname.startsWith("/api/")) {
          sendJson(response, { ok: false, error: "Authentication required", code: "authentication_required" }, 401);
        } else {
          redirect(response, "/login.html");
        }
        return;
      }
      if (url.pathname === "/login.html") {
        redirect(response, "/");
        return;
      }
      if (await handleBusinessProfileRoute(request, response, url, user)) return;
      if (await handleBusinessIntegrationRoute(request, response, url, user)) return;
      if (await handleCustomerRoute(request, response, url, user)) return;
      if (await handleSupplierRoute(request, response, url, user)) return;
      if (await handleSupplyOrderRoute(request, response, url, user)) return;
      if (await handleStorefrontBuyOrderRoute(request, response, url, user)) return;
      if (await handleSalesOrderRoute(request, response, url, user)) return;
      if (await handleProductionBatchRoute(request, response, url, user)) return;
      if (await handleDailyCloseRoute(request, response, url, user)) return;
      if (await handleProductInsightRoute(request, response, url, user)) return;
      if (await handleFinanceRoute(request, response, url, user)) return;
      if (url.pathname === "/api/bootstrap") {
        sendJson(response, await getBootstrapData(user));
        return;
      }
      if (url.pathname === "/api/sync" && request.method === "POST") {
        const payload = await readJsonBody(request);
        if (requiresAdmin(payload) && user.role !== "admin") {
          sendJson(response, { ok: false, error: "Admin access required", code: "admin_required" }, 403);
          return;
        }
        if (requiresManagement(payload) && !isManagementRole(user)) {
          sendJson(response, { ok: false, error: "Manager access required", code: "manager_required" }, 403);
          return;
        }
        stampEmployee(payload, user);
        const syncResult = await syncGuiPayload(payload);
        await auditGuiPayload(payload, user, syncResult).catch(error => {
          console.error("Unable to write GUI audit event:", error.message);
        });
        sendJson(response, syncResult);
        return;
      }
    } else {
      if (authPassword && !isAuthorized(request)) {
        response.writeHead(401, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Business Operations", charset="UTF-8"'
        });
        response.end("Authentication required");
        return;
      }
      const user = {
        id: "legacy-admin",
        fullName: authUser,
        role: "admin",
        status: "active",
        accountManagement: false
      };
      if (url.pathname === "/api/auth/session" && request.method === "GET") {
        sendJson(response, {
          ok: true,
          user
        });
        return;
      }
      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        sendJson(response, { ok: true });
        return;
      }
      if (await handleBusinessProfileRoute(request, response, url, user)) return;
      if (await handleBusinessIntegrationRoute(request, response, url, user)) return;
      if (await handleCustomerRoute(request, response, url, user)) return;
      if (await handleSupplierRoute(request, response, url, user)) return;
      if (await handleSupplyOrderRoute(request, response, url, user)) return;
      if (await handleStorefrontBuyOrderRoute(request, response, url, user)) return;
      if (await handleSalesOrderRoute(request, response, url, user)) return;
      if (await handleProductionBatchRoute(request, response, url, user)) return;
      if (await handleDailyCloseRoute(request, response, url, user)) return;
      if (await handleProductInsightRoute(request, response, url, user)) return;
      if (await handleFinanceRoute(request, response, url, user)) return;
      if (url.pathname === "/api/bootstrap") {
        sendJson(response, await getBootstrapData(null));
        return;
      }
      if (url.pathname === "/api/sync" && request.method === "POST") {
        sendJson(response, await syncGuiPayload(await readJsonBody(request)));
        return;
      }
    }

    serveStatic(response, url.pathname === "/" ? "/index.html" : url.pathname);
  } catch (error) {
    console.error("App request failed:", error);
    sendJson(response, { ok: false, error: "The request could not be completed" }, 500);
  }
}

async function dispatchHostedRequest(request, response, url) {
  if (isPublicPwaAsset(url.pathname)) {
    serveStatic(response, url.pathname);
    return;
  }
  if (url.pathname === "/health") {
    sendJson(response, {
      ok: true,
      service: "business-operations-framework",
      version: packageVersion,
      release: releaseVersion,
      hostedMode: true,
      tenantScoped: true,
      dataBackend: "postgresql",
      databaseConfigured: true,
      databaseReady: true,
      bridgeApiConfigured: Boolean(process.env.BRIDGE_API_TOKEN),
      discordLoginConfigured: Boolean(discordIdentityStore?.enabled),
      personalJobProfiles: Boolean(localIdentityStore?.enabled),
      operatorConsoleConfigured: Boolean(platformOperations?.enabled),
      authMode: discordIdentityStore?.enabled ? "workspace-accounts-and-discord" : "workspace-accounts",
      uptimeSeconds: Math.round(process.uptime())
    });
    return;
  }
  if (url.pathname === "/health/data" || url.pathname === "/health/sheet") {
    sendJson(response, {
      ok: true,
      dataBackend: "postgresql",
      tenantScoped: true,
      databaseReady: true
    });
    return;
  }
  if (await handleOperatorRoute(request, response, url)) return;
  if (url.pathname === "/api/setup/status" && request.method === "GET") {
    sendJson(response, {
      ok: true,
      hostedMode: true,
      setupRequired: hostedSignupMode !== "closed",
      ownerAccountExists: false,
      workspaceSignup: {
        mode: hostedSignupMode,
        inviteRequired: hostedSignupMode === "invite"
      },
      defaults: defaultSetupConfiguration()
    });
    return;
  }
  if (url.pathname === "/api/setup/complete" && request.method === "POST") {
    await handleHostedSetup(request, response);
    return;
  }
  if (url.pathname === "/api/public/config" && request.method === "GET") {
    const context = await tenantManager.getContextByWorkspaceCode(url.searchParams.get("workspace"));
    sendJson(response, context ? {
      ok: true,
      configured: true,
      hostedMode: true,
      workspace: publicWorkspace(context),
      business: context.businessStore.getConfiguration()?.business || { name: context.business.name },
      terminology: context.businessStore.getConfiguration()?.terminology || null
    } : {
      ok: true,
      configured: false,
      hostedMode: true,
      workspaceRequired: true,
      business: null,
      terminology: null
    });
    return;
  }
  if (await handleDiscordIdentityRoute(request, response, url)) return;
  if (url.pathname.startsWith("/api/integrations/discord/")) {
    const integrationHandled = await dispatchHostedDiscordRequest(request, response, url);
    if (integrationHandled) return;
  }
  if (url.pathname === "/setup.html" || url.pathname === "/setup.js"
    || url.pathname === "/login.html" || url.pathname === "/login.js"
    || url.pathname === "/profile.html" || url.pathname === "/profile.js"
    || url.pathname === "/styles.css" || url.pathname.startsWith("/assets/")) {
    serveStatic(response, url.pathname);
    return;
  }

  const sessionToken = readCookie(request, "business_session");
  const localIdentity = readSessionIdentity(sessionToken, sessionSecret);
  const discordMembership = await discordIdentityStore?.authenticateMembershipSession(
    readCookie(request, "discord_membership_session")
  );
  let context = discordMembership
    ? await tenantManager.getContextById(discordMembership.businessId)
    : localIdentity ? await tenantManager.getContextById(localIdentity.businessId) : null;
  if (context && discordMembership) context = { ...context, authenticatedUser: discordMembership };
  if (!context && (url.pathname === "/api/auth/login" || url.pathname === "/api/auth/register") && request.method === "POST") {
    const body = await readJsonBody(request);
    context = await tenantManager.getContextByWorkspaceCode(body.workspaceCode);
    if (!context) {
      sendJson(response, {
        ok: false,
        error: "Workspace code was not found",
        code: "workspace_not_found"
      }, 404);
      return;
    }
  }
  if (!context) {
    if (url.pathname === "/api/auth/session" && request.method === "GET") {
      const discordIdentity = await discordIdentityStore?.verifyIdentitySession(
        readCookie(request, "discord_identity_session")
      );
      sendJson(response, {
        ok: true,
        user: null,
        identity: discordIdentity,
        workspace: null,
        profileRequired: Boolean(discordIdentity)
      });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      sendJson(response, {
        ok: false,
        error: localIdentity || discordMembership
          ? "Business workspace is unavailable"
          : "Authentication and a workspace code are required",
        code: localIdentity || discordMembership ? "workspace_unavailable" : "workspace_required"
      }, localIdentity || discordMembership ? 403 : 401);
      return;
    }
    const discordIdentity = await discordIdentityStore?.verifyIdentitySession(
      readCookie(request, "discord_identity_session")
    );
    redirect(response, discordIdentity ? "/profile.html" : "/login.html");
    return;
  }
  return tenantRequestContext.run(context, () => handleApplicationRequest(request, response, url));
}

async function handleDiscordIdentityRoute(request, response, url) {
  if (!discordIdentityStore) return false;
  if (url.pathname === "/api/discord-auth/status" && request.method === "GET") {
    sendJson(response, { ok: true, enabled: discordIdentityStore.enabled });
    return true;
  }
  if (url.pathname === "/auth/discord" && request.method === "GET") {
    if (!allowAuthAttempt(request)) {
      sendJson(response, {
        ok: false,
        error: "Too many attempts. Try again later.",
        code: "rate_limited"
      }, 429);
      return true;
    }
    try {
      redirect(response, await discordIdentityStore.beginAuthorization(url.searchParams.get("return_to")));
    } catch (error) {
      sendJson(response, {
        ok: false,
        error: error.message || "Discord login is unavailable",
        code: error.code || "discord_login_unavailable"
      }, error.status || 503);
    }
    return true;
  }
  if (url.pathname === "/auth/discord/callback" && request.method === "GET") {
    if (url.searchParams.get("error")) {
      redirect(response, `/login.html?discord_error=${encodeURIComponent(url.searchParams.get("error_description") || "Discord authorization was cancelled")}`);
      return true;
    }
    try {
      const completed = await discordIdentityStore.completeAuthorization({
        state: url.searchParams.get("state"),
        code: url.searchParams.get("code")
      });
      setIdentitySessionCookie(response, request, discordIdentityStore.createIdentitySession(completed.identity));
      redirect(response, completed.returnTo || "/profile.html");
    } catch (error) {
      console.error("Discord OAuth callback failed:", error.message);
      redirect(response, `/login.html?discord_error=${encodeURIComponent(error.message || "Discord login failed")}`);
    }
    return true;
  }
  if (url.pathname === "/profile.html" || url.pathname === "/profile.js") {
    serveStatic(response, url.pathname);
    return true;
  }
  if (!url.pathname.startsWith("/api/profile")) return false;

  if (url.pathname === "/api/profile/logout" && request.method === "POST") {
    clearAllSessionCookies(response, request);
    sendJson(response, { ok: true });
    return true;
  }
  const identity = await discordIdentityStore.verifyIdentitySession(readCookie(request, "discord_identity_session"));
  if (!identity) {
    sendJson(response, { ok: false, error: "Discord authentication required", code: "discord_authentication_required" }, 401);
    return true;
  }
  try {
    if (url.pathname === "/api/profile" && request.method === "GET") {
      sendJson(response, { ok: true, ...(await discordIdentityStore.listProfile(identity.id)) });
      return true;
    }
    if (url.pathname === "/api/profile/characters" && request.method === "POST") {
      const character = await discordIdentityStore.createCharacter(identity.id, await readJsonBody(request));
      sendJson(response, { ok: true, character }, 201);
      return true;
    }
    const characterRoute = url.pathname.match(/^\/api\/profile\/characters\/([^/]+)$/);
    if (characterRoute && request.method === "PATCH") {
      const character = await discordIdentityStore.updateCharacter(
        identity.id,
        decodeURIComponent(characterRoute[1]),
        await readJsonBody(request)
      );
      sendJson(response, { ok: true, character });
      return true;
    }
    if (characterRoute && request.method === "DELETE") {
      const character = await discordIdentityStore.archiveCharacter(identity.id, decodeURIComponent(characterRoute[1]));
      sendJson(response, { ok: true, character });
      return true;
    }
    if (url.pathname === "/api/profile/memberships" && request.method === "POST") {
      const body = await readJsonBody(request);
      const membership = await discordIdentityStore.requestMembership(
        identity.id,
        body.characterId,
        body.workspaceCode
      );
      const context = await tenantManager.getContextById(membership.businessId);
      await context?.accountStore.recordAudit({
        category: "account",
        action: "membership.requested",
        actorId: membership.id,
        actorName: membership.characterName,
        subjectId: membership.id,
        subjectName: membership.characterName,
        details: { accountType: "discord", discordUserId: identity.discordUserId }
      });
      sendJson(response, { ok: true, membership }, 201);
      return true;
    }
    if (url.pathname === "/api/profile/select" && request.method === "POST") {
      const body = await readJsonBody(request);
      const membership = await discordIdentityStore.recordMembershipLogin(
        identity.id,
        body.membershipId,
        body.businessId
      );
      if (!membership) {
        sendJson(response, { ok: false, error: "That business membership is not active", code: "membership_inactive" }, 403);
        return true;
      }
      setDiscordMembershipCookie(response, request, discordIdentityStore.createMembershipSession(membership));
      const context = await tenantManager.getContextById(membership.businessId);
      await context?.accountStore.recordAudit({
        category: "authentication",
        action: "auth.discord_login",
        actorId: membership.id,
        actorName: membership.fullName,
        subjectId: membership.id,
        subjectName: membership.fullName,
        details: { discordUserId: membership.discordUserId, characterId: membership.characterId }
      });
      sendJson(response, { ok: true, user: membership, workspace: publicWorkspace(context) });
      return true;
    }
    if (url.pathname === "/api/profile/link-local" && request.method === "POST") {
      const body = await readJsonBody(request);
      const context = await tenantManager.getContextByWorkspaceCode(body.workspaceCode);
      if (!context) throw routeError("Workspace code was not found", 404, "workspace_not_found");
      const localUser = await context.accountStore.authenticate(body.fullName, body.password);
      const membership = await discordIdentityStore.activateLinkedMembership({
        identityId: identity.id,
        characterId: body.characterId,
        businessId: context.businessId,
        role: localUser.role,
        localUserId: localUser.id
      });
      await context.accountStore.recordAudit({
        category: "account",
        action: "account.discord_linked",
        actorId: membership.id,
        actorName: membership.characterName,
        subjectId: localUser.id,
        subjectName: localUser.fullName,
        details: { discordUserId: identity.discordUserId, characterId: membership.characterId }
      });
      sendJson(response, { ok: true, membership });
      return true;
    }
    sendJson(response, { ok: false, error: "Profile route not found", code: "not_found" }, 404);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Profile request failed",
      code: error.code || "profile_request_failed"
    }, error.status || 500);
  }
  return true;
}

async function handleOperatorRoute(request, response, url) {
  const operatorAsset = url.pathname === "/operator.html"
    || url.pathname === "/operator.js"
    || url.pathname === "/styles.css";
  const operatorApi = url.pathname.startsWith("/api/operator/");
  if (!operatorAsset && !operatorApi) return false;
  if (operatorAsset) {
    serveStatic(response, url.pathname);
    return true;
  }
  if (url.pathname === "/api/operator/session" && request.method === "GET") {
    sendJson(response, {
      ok: true,
      enabled: Boolean(platformOperations?.enabled),
      authenticated: verifyOperatorSession(readCookie(request, "platform_operator_session"))
    });
    return true;
  }
  if (url.pathname === "/api/operator/login" && request.method === "POST") {
    if (!allowAuthAttempt(request)) {
      sendJson(response, { ok: false, error: "Too many attempts. Try again later.", code: "rate_limited" }, 429);
      return true;
    }
    const body = await readJsonBody(request);
    if (!platformOperations?.enabled || !safeEqual(body.secret || "", process.env.PLATFORM_ADMIN_SECRET || "")) {
      sendJson(response, { ok: false, error: "Operator secret is incorrect", code: "operator_credentials_invalid" }, 401);
      return true;
    }
    setCookieHeaders(response, [sessionCookie(
      request,
      "platform_operator_session",
      createOperatorSession(),
      4 * 60 * 60
    )]);
    await platformOperations.recordAudit({ actor: "Service operator", action: "operator.login" });
    sendJson(response, { ok: true });
    return true;
  }
  if (url.pathname === "/api/operator/logout" && request.method === "POST") {
    setCookieHeaders(response, [sessionCookie(request, "platform_operator_session", "", 0)]);
    sendJson(response, { ok: true });
    return true;
  }
  if (!verifyOperatorSession(readCookie(request, "platform_operator_session"))) {
    sendJson(response, { ok: false, error: "Platform operator authentication required", code: "operator_authentication_required" }, 401);
    return true;
  }
  try {
    if (url.pathname === "/api/operator/overview" && request.method === "GET") {
      const [workspaces, invites, audit] = await Promise.all([
        platformOperations.listWorkspaces(),
        platformOperations.listInvites(),
        platformOperations.listAudit(200)
      ]);
      sendJson(response, {
        ok: true,
        generatedAt: new Date().toISOString(),
        continuity: {
          policy: "persistent",
          migrationMode: "in-place",
          archiveFormat: "business-operations-archive-v1"
        },
        workspaces,
        invites,
        audit
      });
      return true;
    }
    if (url.pathname === "/api/operator/invites" && request.method === "POST") {
      const invite = await platformOperations.createInvite(await readJsonBody(request));
      sendJson(response, { ok: true, invite }, 201);
      return true;
    }
    const inviteAction = url.pathname.match(/^\/api\/operator\/invites\/([^/]+)\/revoke$/);
    if (inviteAction && request.method === "POST") {
      const invite = await platformOperations.revokeInvite(decodeURIComponent(inviteAction[1]));
      sendJson(response, { ok: true, invite });
      return true;
    }
    const workspaceAction = url.pathname.match(/^\/api\/operator\/workspaces\/([^/]+)\/(suspend|reactivate)$/);
    if (workspaceAction && request.method === "POST") {
      const body = await readJsonBody(request);
      const businessId = decodeURIComponent(workspaceAction[1]);
      const workspace = await platformOperations.setWorkspaceStatus(
        businessId,
        workspaceAction[2] === "suspend" ? "suspended" : "active",
        "Service operator",
        body.reason
      );
      tenantManager.invalidateContext(businessId);
      sendJson(response, { ok: true, workspace });
      return true;
    }
    const workspaceOwnerReset = url.pathname.match(/^\/api\/operator\/workspaces\/([^/]+)\/reset-owner$/);
    if (workspaceOwnerReset && request.method === "POST") {
      const body = await readJsonBody(request);
      const businessId = decodeURIComponent(workspaceOwnerReset[1]);
      const owner = await tenantManager.resetWorkspaceOwner(businessId, body.password, "Service operator");
      await platformOperations.recordAudit({
        actor: "Service operator",
        action: "workspace.owner_password_reset",
        businessId,
        details: { ownerId: owner.id, ownerName: owner.fullName, sessionsInvalidated: true }
      });
      sendJson(response, { ok: true, owner });
      return true;
    }
    const workspaceExport = url.pathname.match(/^\/api\/operator\/workspaces\/([^/]+)\/export$/);
    if (workspaceExport && request.method === "GET") {
      const businessId = decodeURIComponent(workspaceExport[1]);
      const archive = await tenantManager.exportWorkspace(businessId, {
        system: "hosted-beta-operator-export",
        url: publicBaseUrl(request)
      });
      await platformOperations.recordAudit({
        actor: "Service operator",
        action: "workspace.exported",
        businessId,
        details: { fingerprint: archive.fingerprint }
      });
      const slug = archive.business.configuration.business.name
        .toLocaleLowerCase("en-US")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "business";
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${slug}-${new Date().toISOString().slice(0, 10)}.business-archive.json"`,
        "Cache-Control": "no-store"
      });
      response.end(`${JSON.stringify(archive, null, 2)}\n`);
      return true;
    }
    sendJson(response, { ok: false, error: "Operator route not found", code: "operator_route_not_found" }, 404);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Operator action failed",
      code: error.code || "operator_action_failed"
    }, error.status || 500);
  }
  return true;
}

async function handleHostedSetup(request, response) {
  if (!allowAuthAttempt(request)) {
    sendJson(response, { ok: false, error: "Too many attempts. Try again later.", code: "rate_limited" }, 429);
    return;
  }
  let inviteReservation = null;
  try {
    const body = await readJsonBody(request);
    inviteReservation = await requireHostedSignupAccess(body.inviteCode);
    let created;
    try {
      created = await tenantManager.createWorkspace({
        configuration: body.configuration || body,
        owner: body.owner && typeof body.owner === "object" ? body.owner : {},
        discordIntegration: body.discordIntegration && typeof body.discordIntegration === "object"
          ? body.discordIntegration
          : null,
        metadata: {
          beta: true,
          createdByInviteId: inviteReservation?.id || "legacy-or-open-signup"
        }
      });
    } catch (error) {
      if (inviteReservation) await platformOperations.releaseInvite(inviteReservation.id).catch(() => {});
      throw error;
    }
    if (inviteReservation) {
      await platformOperations.redeemInvite(inviteReservation.id, created.business)
        .catch(error => console.error("Unable to record beta invitation redemption:", error.message));
    }
    const identity = localIdentityStore?.enabled
      ? await localIdentityStore.ensureIdentityForUser(created.business.id, created.owner.id)
      : null;
    setSessionCookie(response, request, created.context.accountStore.createSession(created.owner));
    if (identity) setLocalIdentitySessionCookie(response, request, localIdentityStore.createSession(identity));
    sendJson(response, {
      ok: true,
      user: { ...created.owner, accountType: "local" },
      business: created.context.businessStore.getConfiguration().business,
      workspace: publicWorkspace(created.context)
    }, 201);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Business workspace could not be created",
      code: error.code || "workspace_setup_failed"
    }, error.status || 500);
  }
}

function resolveHostedSignupMode(value) {
  const mode = String(value || "open").trim().toLowerCase();
  return ["open", "invite", "closed"].includes(mode) ? mode : "closed";
}

async function requireHostedSignupAccess(inviteCode) {
  if (hostedSignupMode === "closed") {
    const error = new Error("New business registration is currently closed");
    error.status = 403;
    error.code = "workspace_signup_closed";
    throw error;
  }
  if (hostedSignupMode !== "invite") return null;
  const expected = String(process.env.HOSTED_SIGNUP_SECRET || "");
  if (expected && safeEqual(inviteCode || "", expected)) return null;
  if (platformOperations?.enabled) return platformOperations.reserveInvite(inviteCode);
  if (!expected) {
    const error = new Error("Hosted signup is not configured");
    error.status = 503;
    error.code = "workspace_signup_unavailable";
    throw error;
  }
  const error = new Error("The business invitation code is incorrect");
  error.status = 403;
  error.code = "workspace_invite_invalid";
  throw error;
}

async function dispatchHostedDiscordRequest(request, response, url) {
  const eventRoute = url.pathname === "/api/integrations/discord/events";
  const snapshotRoute = url.pathname === "/api/integrations/discord/snapshot";
  const directoryRoute = url.pathname === "/api/integrations/discord/channels";
  if (!eventRoute && !snapshotRoute && !directoryRoute) return false;
  if (!requireBridgeToken(request, response)) return true;
  if (directoryRoute && request.method === "GET") {
    sendJson(response, { ok: true, integrations: await tenantManager.listDiscordIntegrations() });
    return true;
  }
  let context = null;
  if (eventRoute && request.method === "POST") {
    const body = await readJsonBody(request);
    const channelRoute = await tenantManager.resolveDiscordChannelRoute(body.discord_channel_id);
    context = channelRoute?.context || null;
    if (channelRoute) body.discord_channel_type = channelRoute.channelType;
  } else if (snapshotRoute && request.method === "GET") {
    context = await tenantManager.resolveDiscordChannel(
      url.searchParams.get("discord_channel_id") || request.headers["x-discord-channel-id"]
    );
    if (!context && url.searchParams.get("workspace")) {
      context = await tenantManager.getContextByWorkspaceCode(url.searchParams.get("workspace"));
    }
  }
  if (!context) {
    sendJson(response, {
      ok: false,
      error: "Discord channel is not connected to an active business",
      code: "discord_channel_unregistered"
    }, 404);
    return true;
  }
  await tenantRequestContext.run(context, () => handleDiscordIntegrationRoute(request, response, url, true));
  return true;
}

function requireBridgeToken(request, response) {
  const expectedToken = String(process.env.BRIDGE_API_TOKEN || "");
  const authorization = String(request.headers.authorization || "");
  const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!expectedToken) {
    sendJson(response, { ok: false, error: "BRIDGE_API_TOKEN is not configured", code: "bridge_token_required" }, 503);
    return false;
  }
  if (!suppliedToken || !safeEqual(suppliedToken, expectedToken)) {
    sendJson(response, { ok: false, error: "Invalid integration token", code: "invalid_integration_token" }, 401);
    return false;
  }
  return true;
}

function publicWorkspace(context = currentTenantContext()) {
  if (!context?.business) return null;
  return {
    id: context.business.id,
    code: context.business.workspaceCode,
    name: context.business.name,
    referenceId: context.business.referenceId || ""
  };
}

async function getWorkspaceProfile(request, response, user, resolvedIdentity = null) {
  const currentBusinessId = currentTenantContext().businessId;
  if (user.accountType === "discord") {
    const profile = await discordIdentityStore.listProfile(user.identityId);
    return {
      accountType: "discord",
      currentBusinessId,
      jobs: profile.memberships.map(membership => ({
        id: membership.id,
        membershipId: membership.id,
        accountType: "discord",
        businessId: membership.businessId,
        workspaceCode: membership.workspaceCode,
        businessName: membership.businessName,
        referenceId: membership.referenceId,
        fullName: membership.characterName,
        role: membership.role,
        status: membership.status,
        current: membership.businessId === currentBusinessId
      }))
    };
  }

  if (!localIdentityStore?.enabled) {
    const workspace = publicWorkspace();
    return {
      accountType: "local",
      currentBusinessId,
      jobs: workspace ? [{
        id: `local:${currentBusinessId}:${user.id}`,
        accountType: "local",
        businessId: currentBusinessId,
        workspaceCode: workspace.code,
        businessName: workspace.name,
        referenceId: workspace.referenceId,
        userId: user.id,
        fullName: user.fullName,
        role: user.role,
        status: user.status,
        current: true
      }] : []
    };
  }

  const identity = resolvedIdentity || await localIdentityStore.resolveIdentityForUser(
    readCookie(request, "local_identity_session"),
    currentBusinessId,
    user.id
  );
  setLocalIdentitySessionCookie(response, request, localIdentityStore.createSession(identity));
  const jobs = await localIdentityStore.listJobs(identity.id);
  return {
    accountType: "local",
    currentBusinessId,
    jobs: jobs.map(job => ({ ...job, current: job.businessId === currentBusinessId }))
  };
}

function currentTenantContext() {
  return tenantRequestContext.getStore() || defaultContext;
}

function contextualStore(property) {
  return new Proxy({}, {
    get(_target, key) {
      const store = currentTenantContext()?.[property];
      if (!store) throw new Error(`${property} is unavailable outside a business workspace`);
      const value = store[key];
      return typeof value === "function" ? value.bind(store) : value;
    },
    set(_target, key, value) {
      const store = currentTenantContext()?.[property];
      if (!store) throw new Error(`${property} is unavailable outside a business workspace`);
      store[key] = value;
      return true;
    }
  });
}

async function handleAccountRoute(request, response, url, user) {
  if (isPublicAsset(url.pathname)) {
    serveStatic(response, url.pathname);
    return true;
  }
  if (url.pathname === "/api/auth/session" && request.method === "GET") {
    const jobProfile = hostedMode && user
      ? await getWorkspaceProfile(request, response, user)
      : null;
    sendJson(response, {
      ok: true,
      user: user ? {
        ...user,
        accountType: user.accountType || "local",
        accountManagement: true
      } : null,
      workspace: hostedMode && user ? publicWorkspace() : null,
      jobProfile
    });
    return true;
  }
  if (url.pathname === "/api/workspaces" && request.method === "GET") {
    if (!user) {
      sendJson(response, { ok: false, error: "Authentication required", code: "authentication_required" }, 401);
      return true;
    }
    sendJson(response, { ok: true, profile: await getWorkspaceProfile(request, response, user) });
    return true;
  }
  if (url.pathname === "/api/workspaces/link" && request.method === "POST") {
    if (!user) {
      sendJson(response, { ok: false, error: "Authentication required", code: "authentication_required" }, 401);
      return true;
    }
    if (user.accountType === "discord") {
      sendJson(response, {
        ok: false,
        error: "Add another business membership from your Characters profile",
        code: "discord_membership_profile_required"
      }, 400);
      return true;
    }
    if (!localIdentityStore?.enabled) {
      sendJson(response, { ok: false, error: "Personal job profiles are unavailable", code: "local_identity_disabled" }, 503);
      return true;
    }
    return handleAccountAction(response, async () => {
      const body = await readJsonBody(request);
      const targetContext = await tenantManager.getContextByWorkspaceCode(body.workspaceCode);
      if (!targetContext) throw routeError("Workspace code was not found", 404, "workspace_not_found");
      if (targetContext.businessId === currentTenantContext().businessId) {
        throw routeError("That is already the current business", 400, "workspace_already_current");
      }
      const targetUser = await targetContext.accountStore.authenticate(body.fullName, body.password);
      const identity = await localIdentityStore.resolveIdentityForUser(
        readCookie(request, "local_identity_session"),
        currentTenantContext().businessId,
        user.id
      );
      const job = await localIdentityStore.linkJob(identity.id, targetContext.businessId, targetUser.id);
      setLocalIdentitySessionCookie(response, request, localIdentityStore.createSession(identity));
      await Promise.all([
        accountStore.recordAudit({
          category: "account",
          action: "account.job_linked",
          actorId: user.id,
          actorName: user.fullName,
          subjectId: targetUser.id,
          subjectName: targetUser.fullName,
          details: { businessId: targetContext.businessId, businessName: targetContext.business.name }
        }),
        targetContext.accountStore.recordAudit({
          category: "account",
          action: "account.job_linked",
          actorId: targetUser.id,
          actorName: targetUser.fullName,
          subjectId: targetUser.id,
          subjectName: targetUser.fullName,
          details: { linkedFromBusinessId: currentTenantContext().businessId }
        })
      ]);
      sendJson(response, {
        ok: true,
        job,
        profile: await getWorkspaceProfile(request, response, user, identity)
      }, 201);
    });
  }
  if (url.pathname === "/api/workspaces/select" && request.method === "POST") {
    if (!user) {
      sendJson(response, { ok: false, error: "Authentication required", code: "authentication_required" }, 401);
      return true;
    }
    return handleAccountAction(response, async () => {
      const body = await readJsonBody(request);
      const businessId = String(body.businessId || "");
      if (user.accountType === "discord") {
        const membership = await discordIdentityStore.recordMembershipLogin(
          user.identityId,
          body.membershipId,
          businessId
        );
        if (!membership) throw routeError("That business membership is not active", 403, "membership_inactive");
        const targetContext = await tenantManager.getContextById(membership.businessId);
        if (!targetContext) throw routeError("Business workspace is unavailable", 403, "workspace_unavailable");
        setDiscordMembershipCookie(response, request, discordIdentityStore.createMembershipSession(membership));
        await targetContext.accountStore.recordAudit({
          category: "authentication",
          action: "auth.workspace_switched",
          actorId: membership.id,
          actorName: membership.fullName,
          subjectId: membership.id,
          subjectName: membership.fullName,
          details: { accountType: "discord" }
        });
        sendJson(response, { ok: true, user: membership, workspace: publicWorkspace(targetContext) });
        return;
      }

      if (!localIdentityStore?.enabled) {
        throw routeError("Personal job profiles are unavailable", 503, "local_identity_disabled");
      }

      const identity = await localIdentityStore.resolveIdentityForUser(
        readCookie(request, "local_identity_session"),
        currentTenantContext().businessId,
        user.id
      );
      const job = await localIdentityStore.getActiveJob(identity.id, businessId);
      if (!job) throw routeError("That linked job is not active", 403, "job_inactive");
      const targetContext = await tenantManager.getContextById(job.businessId);
      const targetUser = targetContext?.accountStore.getUserById(job.userId);
      if (!targetContext || !targetUser || targetUser.status !== "active") {
        throw routeError("That linked job is not active", 403, "job_inactive");
      }
      setSessionCookie(response, request, targetContext.accountStore.createSession(targetUser));
      setLocalIdentitySessionCookie(response, request, localIdentityStore.createSession(identity));
      await targetContext.accountStore.recordAudit({
        category: "authentication",
        action: "auth.workspace_switched",
        actorId: targetUser.id,
        actorName: targetUser.fullName,
        subjectId: targetUser.id,
        subjectName: targetUser.fullName,
        details: { accountType: "local" }
      });
      sendJson(response, {
        ok: true,
        user: { ...targetUser, accountType: "local", accountManagement: true },
        workspace: publicWorkspace(targetContext)
      });
    });
  }
  if (url.pathname === "/api/auth/register" && request.method === "POST") {
    if (!allowAuthAttempt(request)) {
      sendJson(response, { ok: false, error: "Too many attempts. Try again later.", code: "rate_limited" }, 429);
      return true;
    }
    return handleAccountAction(response, async () => {
      const body = await readJsonBody(request);
      const registration = await accountStore.register(body.fullName, body.password);
      sendJson(response, { ok: true, user: registration }, 201);
    });
  }
  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    if (!allowAuthAttempt(request)) {
      sendJson(response, { ok: false, error: "Too many attempts. Try again later.", code: "rate_limited" }, 429);
      return true;
    }
    return handleAccountAction(response, async () => {
      const body = await readJsonBody(request);
      const authenticatedUser = await accountStore.authenticate(body.fullName, body.password);
      const identity = localIdentityStore?.enabled
        ? await localIdentityStore.ensureIdentityForUser(currentTenantContext().businessId, authenticatedUser.id)
        : null;
      setSessionCookie(response, request, accountStore.createSession(authenticatedUser));
      if (identity) setLocalIdentitySessionCookie(response, request, localIdentityStore.createSession(identity));
      sendJson(response, {
        ok: true,
        user: { ...authenticatedUser, accountType: "local" },
        workspace: hostedMode ? publicWorkspace() : null
      });
    });
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    if (user) {
      await accountStore.recordAudit({
        category: "authentication",
        action: "auth.logout",
        actorId: user.id,
        actorName: user.fullName,
        subjectId: user.id,
        subjectName: user.fullName
      }).catch(error => console.error("Unable to write logout audit event:", error.message));
    }
    clearAllSessionCookies(response, request);
    sendJson(response, { ok: true });
    return true;
  }
  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    if (!requireManagement(response, user)) return true;
    const memberships = discordIdentityStore && hostedMode
      ? await discordIdentityStore.listBusinessMemberships(currentTenantContext().businessId)
      : [];
    const linkedLocalIds = new Set(memberships.map(entry => entry.localUserId).filter(Boolean));
    const localUsers = accountStore.listUsers()
      .filter(entry => !linkedLocalIds.has(entry.id))
      .map(entry => ({ ...entry, accountType: "local" }));
    const users = [...localUsers, ...memberships].sort((left, right) =>
      staffStatusOrder(left.status) - staffStatusOrder(right.status)
      || left.fullName.localeCompare(right.fullName)
    );
    sendJson(response, { ok: true, users });
    return true;
  }
  if (url.pathname === "/api/admin/audit" && request.method === "GET") {
    if (!requireManagement(response, user)) return true;
    sendJson(response, { ok: true, events: accountStore.listAudit(url.searchParams.get("limit")) });
    return true;
  }

  const userAction = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/(approve|disable|reject|promote|demote)$/);
  if (userAction && request.method === "POST") {
    const [, userId, action] = userAction;
    if ((action === "promote" || action === "demote") && !requireAdmin(response, user)) return true;
    if (action !== "promote" && action !== "demote" && !requireManagement(response, user)) return true;
    return handleAccountAction(response, async () => {
      const membership = discordIdentityStore && hostedMode
        ? await discordIdentityStore.getBusinessMembership(currentTenantContext().businessId, userId)
        : null;
      const result = membership
        ? await discordIdentityStore.manageMembership(currentTenantContext().businessId, userId, action, user)
        : action === "approve"
          ? await accountStore.approve(userId, user)
          : action === "disable"
            ? await accountStore.disable(userId, user)
            : action === "reject"
              ? await accountStore.reject(userId, user)
              : await accountStore.setRole(userId, action === "promote" ? "manager" : "employee", user);
      if (membership) {
        await accountStore.recordAudit({
          category: "staff",
          action: `membership.${action}`,
          actorId: user.id,
          actorName: user.fullName,
          subjectId: result.id,
          subjectName: result.fullName,
          details: { accountType: "discord", role: result.role, status: result.status }
        });
      }
      sendJson(response, { ok: true, user: result });
    });
  }
  return false;
}

async function handleSetupRoute(request, response, url) {
  if (url.pathname === "/setup.html" || url.pathname === "/setup.js" || url.pathname === "/styles.css") {
    serveStatic(response, url.pathname);
    return true;
  }
  if (url.pathname !== "/api/setup/complete" || request.method !== "POST") return false;
  if (!allowAuthAttempt(request)) {
    sendJson(response, { ok: false, error: "Too many attempts. Try again later.", code: "rate_limited" }, 429);
    return true;
  }

  const operation = setupQueue.then(async () => {
    if (businessStore.isConfigured()) {
      const error = new Error("Business setup has already been completed");
      error.status = 409;
      error.code = "setup_already_completed";
      throw error;
    }
    const body = await readJsonBody(request);
    const configuration = normalizeSetupPayload(body.configuration || body);
    const ownerInput = body.owner && typeof body.owner === "object" ? body.owner : {};
    const owner = accountStore.hasUsers()
      ? await accountStore.authenticate(ownerInput.fullName, ownerInput.password)
      : await accountStore.provisionInitialAdmin(ownerInput.fullName, ownerInput.password);
    if (owner.role !== "admin") {
      const error = new Error("The initial setup must be completed by an admin account");
      error.status = 403;
      error.code = "admin_required";
      throw error;
    }
    const saved = await businessStore.completeSetup(configuration, owner);
    if (standaloneStore) await standaloneStore.syncCatalog(saved);
    return { owner, configuration: saved };
  });
  setupQueue = operation.catch(() => {});

  try {
    const result = await operation;
    setSessionCookie(response, request, accountStore.createSession(result.owner));
    sendJson(response, {
      ok: true,
      user: result.owner,
      business: result.configuration.business
    }, 201);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Setup could not be completed",
      code: error.code || "setup_failed"
    }, error.status || 500);
  }
  return true;
}

async function handleAccountAction(response, callback) {
  try {
    await callback();
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Account request failed",
      code: error.code || "account_error"
    }, error.status || 500);
  }
  return true;
}

function requireAdmin(response, user) {
  if (!user) {
    sendJson(response, { ok: false, error: "Authentication required", code: "authentication_required" }, 401);
    return false;
  }
  if (user.role !== "admin") {
    sendJson(response, { ok: false, error: "Admin access required", code: "admin_required" }, 403);
    return false;
  }
  return true;
}

function requireManagement(response, user) {
  if (!user) {
    sendJson(response, { ok: false, error: "Authentication required", code: "authentication_required" }, 401);
    return false;
  }
  if (!isManagementRole(user)) {
    sendJson(response, { ok: false, error: "Manager access required", code: "manager_required" }, 403);
    return false;
  }
  return true;
}

function isManagementRole(user) {
  return user?.role === "admin" || user?.role === "manager";
}

async function handleCustomerRoute(request, response, url, user) {
  if (!url.pathname.startsWith("/api/customers")) return false;

  try {
    if (url.pathname === "/api/customers" && request.method === "GET") {
      sendJson(response, { ok: true, customers: businessStore.listCustomers() });
      return true;
    }
    if (url.pathname === "/api/customers" && request.method === "POST") {
      const customer = await businessStore.saveCustomer(await readJsonBody(request), user);
      await recordCustomerAudit("customer.saved", customer, user);
      sendJson(response, { ok: true, customer, customers: businessStore.listCustomers() });
      return true;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/customers/")) {
      if (!requireManagement(response, user)) return true;
      const customerId = decodeURIComponent(url.pathname.slice("/api/customers/".length));
      const customer = await businessStore.removeCustomer(customerId);
      await recordCustomerAudit("customer.removed", customer, user);
      sendJson(response, { ok: true, customer, customers: businessStore.listCustomers() });
      return true;
    }
    sendJson(response, { ok: false, error: "Customer route not found", code: "not_found" }, 404);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Customer request failed",
      code: error.code || "customer_error"
    }, error.status || 500);
  }
  return true;
}

async function handleSupplierRoute(request, response, url, user) {
  if (!url.pathname.startsWith("/api/suppliers")) return false;
  if (!requireManagement(response, user)) return true;

  try {
    if (url.pathname === "/api/suppliers" && request.method === "GET") {
      sendJson(response, { ok: true, suppliers: businessStore.listSuppliers() });
      return true;
    }
    if (url.pathname === "/api/suppliers" && request.method === "POST") {
      const supplier = await businessStore.saveSupplier(await readJsonBody(request), user);
      await recordSupplierAudit("supplier.saved", supplier, user);
      sendJson(response, { ok: true, supplier, suppliers: businessStore.listSuppliers() });
      return true;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/suppliers/")) {
      const supplierId = decodeURIComponent(url.pathname.slice("/api/suppliers/".length));
      const supplier = await businessStore.removeSupplier(supplierId);
      await recordSupplierAudit("supplier.removed", supplier, user);
      sendJson(response, { ok: true, supplier, suppliers: businessStore.listSuppliers() });
      return true;
    }
    sendJson(response, { ok: false, error: "Supplier route not found", code: "not_found" }, 404);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Supplier request failed",
      code: error.code || "supplier_error"
    }, error.status || 500);
  }
  return true;
}

async function handleDiscordIntegrationRoute(request, response, url, tokenVerified = false) {
  const eventRoute = url.pathname === "/api/integrations/discord/events";
  const snapshotRoute = url.pathname === "/api/integrations/discord/snapshot";
  if (!eventRoute && !snapshotRoute) return false;
  if (!standaloneStore) {
    sendJson(response, {
      ok: false,
      error: "The direct Discord API requires DATABASE_URL",
      code: "database_required"
    }, 503);
    return true;
  }
  if (!tokenVerified) {
    const expectedToken = String(process.env.BRIDGE_API_TOKEN || "");
    if (!expectedToken) {
      sendJson(response, {
        ok: false,
        error: "BRIDGE_API_TOKEN is not configured",
        code: "bridge_token_required"
      }, 503);
      return true;
    }
    const authorization = String(request.headers.authorization || "");
    const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!suppliedToken || !safeEqual(suppliedToken, expectedToken)) {
      sendJson(response, { ok: false, error: "Invalid integration token", code: "invalid_integration_token" }, 401);
      return true;
    }
  }
  try {
    if (eventRoute && request.method === "POST") {
      sendJson(response, await standaloneStore.ingestWebhook(await readJsonBody(request)));
      return true;
    }
    if (snapshotRoute && request.method === "GET") {
      const snapshot = await standaloneStore.snapshot();
      sendJson(response, {
        ok: true,
        workspace: publicWorkspace(),
        schemaVersion: snapshot.schemaVersion,
        generatedAt: snapshot.generatedAt,
        inventory: { products: snapshot.inventory?.products || [] }
      });
      return true;
    }
    sendJson(response, { ok: false, error: "Integration route not found", code: "not_found" }, 404);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Integration request failed",
      code: error.code || "integration_error"
    }, error.status || 500);
  }
  return true;
}

async function handleBusinessIntegrationRoute(request, response, url, user) {
  if (!tenantManager || url.pathname !== "/api/integrations/discord/configuration") return false;
  if (request.method === "GET") {
    if (!requireManagement(response, user)) return true;
    sendJson(response, {
      ok: true,
      workspace: publicWorkspace(),
      integration: await tenantManager.getDiscordIntegration(currentTenantContext().businessId)
    });
    return true;
  }
  if (request.method === "POST") {
    if (!requireAdmin(response, user)) return true;
    try {
      const integration = await tenantManager.saveDiscordIntegration(
        currentTenantContext().businessId,
        await readJsonBody(request)
      );
      await accountStore.recordAudit({
        category: "integration",
        action: "discord.configuration_updated",
        actorId: user.id,
        actorName: user.fullName,
        subjectId: currentTenantContext().businessId,
        subjectName: currentTenantContext().business.name,
        details: {
          guildId: integration.guildId,
          eventChannelId: integration.eventChannelId,
          storageLedgerChannelId: integration.storageLedgerChannelId,
          inventoryChannelId: integration.inventoryChannelId,
          alertChannelId: integration.alertChannelId
        }
      });
      sendJson(response, { ok: true, workspace: publicWorkspace(), integration });
    } catch (error) {
      sendJson(response, {
        ok: false,
        error: error.message || "Discord configuration could not be saved",
        code: error.code || "discord_configuration_failed"
      }, error.status || 500);
    }
    return true;
  }
  sendJson(response, { ok: false, error: "Integration route not found", code: "not_found" }, 404);
  return true;
}

async function handleBusinessProfileRoute(request, response, url, user) {
  if (url.pathname !== "/api/admin/business-profile") return false;
  if (!requireAdmin(response, user)) return true;
  if (request.method === "GET") {
    const configuration = businessStore.getConfiguration();
    sendJson(response, {
      ok: true,
      business: configuration?.business || null,
      terminology: configuration?.terminology || null,
      navigation: configuration?.navigation || null,
      updatedAt: configuration?.updatedAt || "",
      updatedBy: configuration?.updatedBy || ""
    });
    return true;
  }
  if (request.method !== "PUT") {
    sendJson(response, { ok: false, error: "Business profile route not found", code: "not_found" }, 404);
    return true;
  }
  try {
    const previousConfiguration = businessStore.getConfiguration() || {};
    const previous = previousConfiguration.business || {};
    const configuration = await businessStore.updateBusinessProfile(await readJsonBody(request), user);
    if (tenantManager) {
      await tenantManager.updateWorkspaceIdentity(
        currentTenantContext().businessId,
        configuration.business
      );
    }
    await accountStore.recordAudit({
      category: "business",
      action: "business.profile_updated",
      actorId: user.id,
      actorName: user.fullName,
      subjectId: currentTenantContext().businessId,
      subjectName: configuration.business.name,
      details: {
        previousName: previous.name || "",
        name: configuration.business.name,
        location: configuration.business.location,
        referenceId: configuration.business.referenceId,
        logoChanged: previous.logoUrl !== configuration.business.logoUrl,
        appearanceChanged: previous.appearanceTheme !== configuration.business.appearanceTheme,
        navigationChanged: JSON.stringify(previousConfiguration.navigation?.sections || {})
          !== JSON.stringify(configuration.navigation?.sections || {})
      }
    }).catch(error => console.error("Unable to write business profile audit event:", error.message));
    sendJson(response, {
      ok: true,
      business: configuration.business,
      terminology: configuration.terminology,
      navigation: configuration.navigation,
      workspace: tenantManager ? publicWorkspace() : null,
      updatedAt: configuration.updatedAt,
      updatedBy: configuration.updatedBy
    });
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Business profile could not be saved",
      code: error.code || "business_profile_failed"
    }, error.status || 500);
  }
  return true;
}

async function handleFinanceRoute(request, response, url, user) {
  if (url.pathname !== "/api/finance") return false;
  if (!requireAdmin(response, user)) return true;
  if (request.method !== "GET") {
    sendJson(response, { ok: false, error: "Finance route not found", code: "not_found" }, 404);
    return true;
  }

  const from = cleanDateParameter(url.searchParams.get("from"));
  const to = cleanDateParameter(url.searchParams.get("to"));
  if (from && to && from > to) {
    sendJson(response, { ok: false, error: "Finance start date must be before the end date", code: "invalid_finance_period" }, 400);
    return true;
  }

  const finance = await readAppsScriptAction("finance", { from, to });
  if (!finance?.ok || !finance.totals || !finance.balances) {
    sendJson(response, {
      ok: false,
      error: finance?.error || "Finance data is unavailable from the configured data backend.",
      code: "finance_snapshot_unavailable"
    }, 502);
    return true;
  }
  const reconciledFinance = mergeRecordedPurchaseFinance(finance, buildRecordedPurchaseFinance(from, to));
  const sheet = await readSheetSnapshot();
  const commitments = buildFinanceCommitments(sheet);
  const ledgerBalance = finiteOrNull(finance.ledger?.balance ?? sheet?.inventory?.ledger?.balance);
  const safekeepingHeld = Number(reconciledFinance.balances.safekeeping || 0);
  const businessCash = ledgerBalance === null ? null : ledgerBalance - safekeepingHeld;
  const availableAfterCommitments = businessCash === null ? null : businessCash - commitments.total;
  sendJson(response, {
    ok: true,
    generatedAt: new Date().toISOString(),
    period: { from: finance.from || from, to: finance.to || to },
    totals: reconciledFinance.totals,
    balances: reconciledFinance.balances,
    breakdown: reconciledFinance.breakdown,
    monthly: reconciledFinance.monthly,
    coverage: reconciledFinance.coverage,
    cash: {
      ledgerBalance,
      safekeepingHeld,
      businessCash,
      committed: commitments.total,
      availableAfterCommitments
    },
    commitments
  });
  return true;
}

async function handleProductInsightRoute(request, response, url, user) {
  const route = url.pathname.match(/^\/api\/product-insights\/([^/]+)$/);
  if (!route) return false;
  if (!requireManagement(response, user)) return true;
  if (request.method !== "GET") {
    sendJson(response, { ok: false, error: "Product insight route not found", code: "not_found" }, 404);
    return true;
  }

  const requested = decodeURIComponent(route[1]);
  const catalog = mergeCatalogWithSheetProducts(businessStore.getCatalogData(), await readSheetSnapshot());
  const requestedKey = inventoryKey(requested);
  const item = catalog.items.find(candidate => [
    candidate.name,
    candidate.label,
    candidate.tag,
    ...(Array.isArray(candidate.aliases) ? candidate.aliases : [])
  ].some(value => inventoryKey(value) === requestedKey));
  if (!item) {
    sendJson(response, { ok: false, error: "Product not found", code: "product_not_found" }, 404);
    return true;
  }

  const finance = await readAppsScriptAction("finance");
  if (!finance?.ok || !Array.isArray(finance.breakdown)) {
    sendJson(response, {
      ok: false,
      error: finance?.error || "Sales history is temporarily unavailable",
      code: "product_sales_unavailable"
    }, 502);
    return true;
  }

  const productKeys = new Set([
    item.name,
    item.label,
    item.tag,
    ...(Array.isArray(item.aliases) ? item.aliases : [])
  ].map(inventoryKey).filter(Boolean));
  const channels = new Map();
  finance.breakdown.forEach(row => {
    if (row.type !== "Revenue" || !productKeys.has(inventoryKey(row.label))) return;
    const category = String(row.category || "Other Sales");
    const current = channels.get(category) || { category, revenue: 0, transactions: 0 };
    current.revenue += Number(row.amount || 0);
    current.transactions += Number(row.count || 0);
    channels.set(category, current);
  });
  const channelRows = [...channels.values()]
    .map(channel => ({
      ...channel,
      revenue: roundFinanceMoney(channel.revenue),
      averageTransaction: channel.transactions
        ? roundFinanceMoney(channel.revenue / channel.transactions)
        : 0
    }))
    .sort((a, b) => b.revenue - a.revenue || a.category.localeCompare(b.category));
  const revenue = roundFinanceMoney(channelRows.reduce((sum, channel) => sum + channel.revenue, 0));
  const transactions = channelRows.reduce((sum, channel) => sum + channel.transactions, 0);
  sendJson(response, {
    ok: true,
    generatedAt: finance.generatedAt || new Date().toISOString(),
    item: { name: item.name, label: item.label, category: item.category },
    sales: {
      revenue,
      transactions,
      averageTransaction: transactions ? roundFinanceMoney(revenue / transactions) : 0,
      channels: channelRows
    }
  });
  return true;
}

function buildFinanceCommitments(sheet) {
  const supplyLines = [];
  businessStore.listSupplyOrders()
    .filter(order => order.status === "Ordered" || order.status === "Partially Received")
    .forEach(order => order.lines.forEach(line => {
      const quantity = Math.max(0, Number(line.quantity || 0) - Number(line.receivedQuantity || 0));
      const unitPrice = Math.max(0, Number(line.unitPrice || 0));
      if (!quantity) return;
      supplyLines.push({
        orderId: order.id,
        producer: order.producer,
        label: line.label || line.name,
        quantity,
        unitPrice,
        amount: roundFinanceMoney(quantity * unitPrice)
      });
    }));

  const buyOrderLines = businessStore.listStorefrontBuyOrders()
    .filter(order => order.status === "Active" || order.status === "Paused")
    .map(order => {
      const quantity = Math.max(0, Number(order.quantity || 0) - Number(order.filledQuantity || 0));
      const unitPrice = Math.max(0, Number(order.unitPrice || 0));
      return {
        orderId: order.id,
        label: order.itemLabel || order.itemName,
        quantity,
        unitPrice,
        amount: roundFinanceMoney(quantity * unitPrice)
      };
    })
    .filter(line => line.quantity > 0);

  const restock = buildRestockCommitment(sheet, [...supplyLines, ...buyOrderLines]);
  const supplyOrders = roundFinanceMoney(supplyLines.reduce((sum, line) => sum + line.amount, 0));
  const storefrontBuyOrders = roundFinanceMoney(buyOrderLines.reduce((sum, line) => sum + line.amount, 0));
  const total = roundFinanceMoney(supplyOrders + storefrontBuyOrders + restock.amount);
  return {
    total,
    supplyOrders,
    storefrontBuyOrders,
    missingStock: restock.amount,
    supplyLines,
    buyOrderLines,
    restockLines: restock.lines,
    missingProducts: restock.missingProducts,
    unpricedLines: restock.unpricedLines
  };
}

function buildRestockCommitment(sheet, committedPurchaseLines) {
  const catalog = businessStore.getCatalogData();
  const inventory = sheet?.inventory || {};
  const demand = new Map();
  const productionLines = [];
  const missingProducts = [];
  const storage = new Map();
  const storageRows = Array.isArray(inventory.storage) && inventory.storage.length
    ? inventory.storage
    : inventory.materials;
  (Array.isArray(storageRows) ? storageRows : []).forEach(row => {
    const name = row.ingredient || row.itemName || row.itemLabel || row.name;
    storage.set(inventoryKey(name), Math.max(0, Number(row.storageCount ?? row.quantity ?? 0)));
  });
  (Array.isArray(inventory.products) ? inventory.products : []).forEach(product => {
    const name = product.itemName || product.itemLabel;
    const storefrontMissing = Math.max(0, Number(product.target || 0) - Number(product.currentStock || 0));
    const storageAvailable = storage.get(inventoryKey(name)) || 0;
    const missing = Math.max(0, storefrontMissing - storageAvailable);
    if (!missing) return;
    const recipe = catalog.recipes[name];
    missingProducts.push({
      label: product.itemLabel || name,
      quantity: missing,
      storefrontMissing,
      storageAvailable,
      recipeAvailable: Boolean(recipe)
    });
    if (!recipe) return;
    productionLines.push({ itemName: name, requestedQuantity: missing });
  });
  const staged = planProduction({
    lines: productionLines,
    recipes: catalog.recipes,
    recipeYields: catalog.recipeYields,
    counts: { Storage: storage },
    rootOutputLocation: "Storefront"
  });
  staged.materials.forEach(material => {
    const key = inventoryKey(material.ingredient);
    const current = demand.get(key) || { ingredient: material.ingredient, quantity: 0 };
    current.quantity += Number(material.needed || 0);
    demand.set(key, current);
  });

  const ordered = new Map();
  committedPurchaseLines.forEach(line => {
    const key = inventoryKey(line.label);
    ordered.set(key, (ordered.get(key) || 0) + Number(line.quantity || 0));
  });

  const lines = [];
  let unpricedLines = 0;
  demand.forEach((line, key) => {
    const quantity = Math.max(0, line.quantity - (storage.get(key) || 0) - (ordered.get(key) || 0));
    if (!quantity) return;
    const unitPrice = preferredFinanceMaterialPrice(line.ingredient, catalog.pricing);
    if (!unitPrice) unpricedLines += 1;
    lines.push({
      label: line.ingredient,
      quantity,
      unitPrice,
      amount: roundFinanceMoney(quantity * unitPrice)
    });
  });
  lines.sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
  return {
    amount: roundFinanceMoney(lines.reduce((sum, line) => sum + line.amount, 0)),
    lines,
    missingProducts,
    unpricedLines
  };
}

function preferredFinanceMaterialPrice(name, pricing) {
  const key = inventoryKey(name);
  const supplierPrices = businessStore.listSuppliers().flatMap(supplier =>
    supplier.products
      .filter(product => inventoryKey(product.name || product.label) === key)
      .map(product => Number(product.unitPrice || 0))
      .filter(price => price > 0)
  );
  if (supplierPrices.length) return Math.min(...supplierPrices);
  const matched = Object.entries(pricing?.materials || {})
    .find(([material]) => inventoryKey(material) === key);
  return Math.max(0, Number(matched?.[1]?.midpoint || 0));
}

function cleanDateParameter(value) {
  const date = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function roundFinanceMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function buildRecordedPurchaseFinance(from, to) {
  const breakdown = new Map();
  const monthly = new Map();
  let expenses = 0;
  let receiptCount = 0;
  let legacyReceiptCount = 0;
  let supplierReceiptExpenses = 0;
  let manualBuyOrderUnits = 0;
  let manualBuyOrderExpenses = 0;

  function addExpense({ date, amount, category, label, source }) {
    if (!date || (from && date < from) || (to && date > to) || !amount) return false;
    expenses += amount;
    const key = `${category}|${label}|${source}`;
    const existing = breakdown.get(key) || {
      type: "Expense",
      category,
      label,
      source,
      amount: 0,
      count: 0
    };
    existing.amount += amount;
    existing.count += 1;
    breakdown.set(key, existing);
    const month = date.slice(0, 7);
    const monthEntry = monthly.get(month) || { month, revenue: 0, expenses: 0, profit: 0 };
    monthEntry.expenses += amount;
    monthly.set(month, monthEntry);
    return true;
  }

  businessStore.listSupplyOrders().forEach(order => {
    order.lines.forEach(line => {
      (Array.isArray(line.receipts) ? line.receipts : []).forEach(receipt => {
        const date = financeDateKey(receipt.receivedAt);
        const amount = roundFinanceMoney(Number(receipt.quantity || 0) * Number(receipt.unitPrice || 0));
        const legacyReceipt = String(receipt.id || "").startsWith("legacy-receipt:");
        if (legacyReceipt) {
          legacyReceiptCount += 1;
          return;
        }
        if (!addExpense({
          date,
          amount,
          category: "Supplier Purchases",
          label: line.label || line.name || "Supplier materials",
          source: order.producer || "Supplier"
        })) return;
        receiptCount += 1;
        supplierReceiptExpenses += amount;
      });
    });
  });

  const buyOrders = businessStore.listStorefrontBuyOrders();
  buyOrders.forEach(order => {
    const quantity = Math.max(0, Number(order.manualFilledQuantity || 0));
    const amount = roundFinanceMoney(quantity * Number(order.unitPrice || 0));
    if (!addExpense({
      date: financeDateKey(order.updatedAt || order.postedAt),
      amount,
      category: "Storefront Buy Orders",
      label: order.itemLabel || order.itemName || "Buy order purchase",
      source: "Manual fill"
    })) return;
    manualBuyOrderUnits += quantity;
    manualBuyOrderExpenses += amount;
  });

  return {
    expenses: roundFinanceMoney(expenses),
    breakdown: [...breakdown.values()].map(row => ({ ...row, amount: roundFinanceMoney(row.amount) })),
    monthly: [...monthly.values()].map(row => ({
      ...row,
      expenses: roundFinanceMoney(row.expenses),
      profit: roundFinanceMoney(row.revenue - row.expenses)
    })),
    coverage: {
      supplierReceipts: receiptCount,
      legacySupplierReceipts: legacyReceiptCount,
      supplierReceiptExpenses: roundFinanceMoney(supplierReceiptExpenses),
      buyOrdersReviewed: buyOrders.length,
      webhookBuyOrderFills: buyOrders.reduce((sum, order) => sum + (order.fillEvents || []).length, 0),
      manualBuyOrderUnits,
      manualBuyOrderExpenses: roundFinanceMoney(manualBuyOrderExpenses)
    }
  };
}

function mergeRecordedPurchaseFinance(finance, recorded) {
  const totals = {
    revenue: roundFinanceMoney(finance.totals.revenue),
    expenses: roundFinanceMoney(Number(finance.totals.expenses || 0) + recorded.expenses),
    profit: 0
  };
  totals.profit = roundFinanceMoney(totals.revenue - totals.expenses);
  const monthly = new Map((Array.isArray(finance.monthly) ? finance.monthly : []).map(row => [row.month, {
    month: row.month,
    revenue: Number(row.revenue || 0),
    expenses: Number(row.expenses || 0),
    profit: Number(row.profit || 0)
  }]));
  recorded.monthly.forEach(row => {
    const existing = monthly.get(row.month) || { month: row.month, revenue: 0, expenses: 0, profit: 0 };
    existing.expenses = roundFinanceMoney(existing.expenses + row.expenses);
    existing.profit = roundFinanceMoney(existing.revenue - existing.expenses);
    monthly.set(row.month, existing);
  });
  return {
    totals,
    balances: finance.balances,
    breakdown: [...(Array.isArray(finance.breakdown) ? finance.breakdown : []), ...recorded.breakdown]
      .sort((a, b) => a.type.localeCompare(b.type) || Number(b.amount || 0) - Number(a.amount || 0)),
    monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)),
    coverage: {
      ...(finance.coverage && typeof finance.coverage === "object" ? finance.coverage : {}),
      ...recorded.coverage
    }
  };
}

function financeDateKey(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

async function handleSupplyOrderRoute(request, response, url, user) {
  if (!url.pathname.startsWith("/api/supply-orders")) return false;
  if (!requireManagement(response, user)) return true;

  try {
    if (url.pathname === "/api/supply-orders" && request.method === "GET") {
      sendJson(response, { ok: true, orders: businessStore.listSupplyOrders() });
      return true;
    }
    if (url.pathname === "/api/supply-orders" && request.method === "POST") {
      const order = await businessStore.saveSupplyOrder(await readJsonBody(request), user);
      await recordSupplyOrderAudit("supply_order.saved", order, user);
      sendJson(response, { ok: true, order, orders: businessStore.listSupplyOrders() });
      return true;
    }
    const receiptRoute = url.pathname.match(/^\/api\/supply-orders\/([^/]+)\/receive$/);
    if (receiptRoute && request.method === "POST") {
      const orderId = decodeURIComponent(receiptRoute[1]);
      const payload = await readJsonBody(request);
      const operation = supplyReceiptQueue.then(() => receiveSupplyOrder(orderId, payload, user));
      supplyReceiptQueue = operation.catch(() => {});
      sendJson(response, await operation);
      return true;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/supply-orders/")) {
      const orderId = decodeURIComponent(url.pathname.slice("/api/supply-orders/".length));
      const order = await businessStore.removeSupplyOrder(orderId);
      await recordSupplyOrderAudit("supply_order.removed", order, user);
      sendJson(response, { ok: true, order, orders: businessStore.listSupplyOrders() });
      return true;
    }
    sendJson(response, { ok: false, error: "Supply order route not found", code: "not_found" }, 404);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Supply order request failed",
      code: error.code || "supply_order_error"
    }, error.status || 500);
  }
  return true;
}

async function handleStorefrontBuyOrderRoute(request, response, url, user) {
  if (!url.pathname.startsWith("/api/storefront-buy-orders")) return false;
  if (!requireManagement(response, user)) return true;

  try {
    if (url.pathname === "/api/storefront-buy-orders" && request.method === "GET") {
      await reconcileStorefrontBuyOrdersFromSheet();
      sendJson(response, { ok: true, orders: businessStore.listStorefrontBuyOrders() });
      return true;
    }
    if (url.pathname === "/api/storefront-buy-orders" && request.method === "POST") {
      const order = await businessStore.saveStorefrontBuyOrder(await readJsonBody(request), user);
      await recordStorefrontBuyOrderAudit("storefront_buy_order.saved", order, user);
      sendJson(response, { ok: true, order, orders: businessStore.listStorefrontBuyOrders() });
      return true;
    }
    const fillRoute = url.pathname.match(/^\/api\/storefront-buy-orders\/([^/]+)\/fill$/);
    if (fillRoute && request.method === "POST") {
      const orderId = decodeURIComponent(fillRoute[1]);
      const payload = await readJsonBody(request);
      const order = await businessStore.setStorefrontBuyOrderFill(orderId, payload.filledQuantity, user);
      await recordStorefrontBuyOrderAudit("storefront_buy_order.fill_adjusted", order, user);
      sendJson(response, { ok: true, order, orders: businessStore.listStorefrontBuyOrders() });
      return true;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/storefront-buy-orders/")) {
      const orderId = decodeURIComponent(url.pathname.slice("/api/storefront-buy-orders/".length));
      const order = await businessStore.removeStorefrontBuyOrder(orderId);
      await recordStorefrontBuyOrderAudit("storefront_buy_order.removed", order, user);
      sendJson(response, { ok: true, order, orders: businessStore.listStorefrontBuyOrders() });
      return true;
    }
    sendJson(response, { ok: false, error: "Storefront buy order route not found", code: "not_found" }, 404);
    return true;
  } catch (error) {
    sendJson(response, { ok: false, error: error.message, code: error.code || "storefront_buy_order_failed" }, error.status || 500);
    return true;
  }
}

async function handleSalesOrderRoute(request, response, url, user) {
  if (!url.pathname.startsWith("/api/sales-orders")) return false;

  try {
    if (url.pathname === "/api/sales-orders" && request.method === "GET") {
      sendJson(response, { ok: true, orders: businessStore.listSalesOrders() });
      return true;
    }
    if (url.pathname === "/api/sales-orders/import" && request.method === "POST") {
      const payload = await readJsonBody(request);
      const result = await businessStore.importSalesOrders(payload.orders, user);
      await recordSalesOrderImportAudit(result, user);
      sendJson(response, { ok: true, ...result });
      return true;
    }
    if (url.pathname === "/api/sales-orders" && request.method === "POST") {
      const payload = await readJsonBody(request);
      const existingOrder = businessStore.getSalesOrder(payload.id);
      const activeBatch = businessStore.listProductionBatches().find(batch =>
        ORDER_PRODUCTION_SOURCE_TYPES.has(batch.sourceType)
        && batch.sourceId === String(payload.id || "")
        && batch.status !== "Completed"
        && batch.status !== "Cancelled"
      );
      if (activeBatch && existingOrder && payload.status !== existingOrder.status) {
        throw salesOrderError(
          "Finish or cancel the linked production batch before changing this order's status",
          409,
          "sales_order_production_active"
        );
      }
      if (payload.status === "Cancelled" && existingOrder?.status !== "Cancelled" && !isManagementRole(user)) {
        throw salesOrderError("Manager access is required to cancel an order", 403, "manager_required");
      }
      if (["In Production", "Ready"].includes(payload.status) && existingOrder?.status !== payload.status) {
        throw salesOrderError(
          "Production controls update this order status automatically",
          400,
          "sales_order_status_managed"
        );
      }
      if ((payload.orderType === "Internal Craft" || existingOrder?.orderType === "Internal Craft")
        && payload.status === "Completed"
        && existingOrder?.status !== "Completed") {
        throw salesOrderError(
          "Internal crafts complete automatically when their production batch is finished",
          400,
          "internal_craft_status_managed"
        );
      }
      const linkedBatch = businessStore.listProductionBatches().find(batch =>
        ORDER_PRODUCTION_SOURCE_TYPES.has(batch.sourceType)
        && batch.sourceId === String(payload.id || "")
        && batch.status !== "Cancelled"
      );
      if (linkedBatch?.status === "Completed"
        && existingOrder?.status === "Ready"
        && !["Ready", "Completed"].includes(payload.status)
        && !isManagementRole(user)) {
        throw salesOrderError(
          "Ready orders can only be completed by employees",
          409,
          "sales_order_ready_locked"
        );
      }
      if (linkedBatch && existingOrder && salesOrderProductionShape(payload) !== salesOrderProductionShape(existingOrder)) {
        throw salesOrderError(
          "Production details are locked after an order is queued",
          409,
          "sales_order_production_locked"
        );
      }
      if (payload.status === "Completed") {
        if (activeBatch) {
          throw salesOrderError(
            "Finish the linked production batch before completing this order",
            409,
            "sales_order_production_incomplete"
          );
        }
      }
      let fulfillmentSynced = false;
      if (payload.status === "Completed"
        && existingOrder?.status !== "Completed"
        && linkedBatch?.status === "Completed"
        && linkedBatch.sourceType === "Customer Order") {
        if (Number(payload.revision) !== Number(existingOrder.revision)) {
          throw salesOrderError(
            "This order was updated by someone else. Reload it before completing delivery.",
            409,
            "sales_order_conflict"
          );
        }
        await syncCustomerOrderFulfillment(existingOrder, linkedBatch, user);
        fulfillmentSynced = true;
      }
      const order = await businessStore.saveSalesOrder(payload, user);
      await recordSalesOrderAudit("sales_order.saved", order, user);
      sendJson(response, { ok: true, order, orders: businessStore.listSalesOrders(), fulfillmentSynced });
      return true;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/sales-orders/")) {
      if (!requireManagement(response, user)) return true;
      const orderId = decodeURIComponent(url.pathname.slice("/api/sales-orders/".length));
      const linkedBatch = businessStore.listProductionBatches().find(batch =>
        ORDER_PRODUCTION_SOURCE_TYPES.has(batch.sourceType)
        && batch.sourceId === orderId
        && batch.status !== "Cancelled"
      );
      if (linkedBatch) {
        throw salesOrderError(
          "This order is linked to production and must be cancelled instead of removed",
          409,
          "sales_order_has_production"
        );
      }
      const order = await businessStore.removeSalesOrder(orderId);
      await recordSalesOrderAudit("sales_order.removed", order, user);
      sendJson(response, { ok: true, order, orders: businessStore.listSalesOrders() });
      return true;
    }
    sendJson(response, { ok: false, error: "Sales order route not found", code: "not_found" }, 404);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Sales order request failed",
      code: error.code || "sales_order_error"
    }, error.status || 500);
  }
  return true;
}

function salesOrderError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function isInternalCraftOrder(order) {
  return order?.orderType === "Internal Craft";
}

function isCounterSaleOrder(order) {
  return order?.orderType === "Counter Sale";
}

function productionSourceTypeForOrder(order) {
  return isInternalCraftOrder(order) ? "Internal Craft" : "Customer Order";
}

function salesOrderDisplayName(order) {
  if (isInternalCraftOrder(order)) return order?.label || "Internal stock build";
  if (isCounterSaleOrder(order)) return order?.label || "Over-the-counter cash sale";
  return order?.customer || "Unnamed customer";
}

async function handleDailyCloseRoute(request, response, url, user) {
  if (!url.pathname.startsWith("/api/daily-closes")) return false;
  if (!requireManagement(response, user)) return true;

  try {
    if (url.pathname === "/api/daily-closes" && request.method === "GET") {
      sendJson(response, { ok: true, closes: businessStore.listDailyCloses() });
      return true;
    }
    if (url.pathname === "/api/daily-closes" && request.method === "POST") {
      const close = await businessStore.saveDailyClose(await readJsonBody(request), await buildDailyCloseSnapshot(), user);
      await recordDailyCloseAudit("daily_close.saved", close, user);
      sendJson(response, { ok: true, close, closes: businessStore.listDailyCloses() });
      return true;
    }
    const actionRoute = url.pathname.match(/^\/api\/daily-closes\/([^/]+)\/(finalize|reopen)$/);
    if (actionRoute && request.method === "POST") {
      const closeId = decodeURIComponent(actionRoute[1]);
      const action = actionRoute[2];
      if (action === "reopen") {
        if (!requireAdmin(response, user)) return true;
        const close = await businessStore.reopenDailyClose(closeId, user);
        await recordDailyCloseAudit("daily_close.reopened", close, user);
        sendJson(response, { ok: true, close, closes: businessStore.listDailyCloses() });
        return true;
      }
      const payload = await readJsonBody(request);
      const close = await businessStore.finalizeDailyClose(
        closeId,
        payload.revision,
        await buildDailyCloseSnapshot(),
        user
      );
      await recordDailyCloseAudit("daily_close.finalized", close, user);
      sendJson(response, { ok: true, close, closes: businessStore.listDailyCloses() });
      return true;
    }
    sendJson(response, { ok: false, error: "Daily close route not found", code: "not_found" }, 404);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Daily close request failed",
      code: error.code || "daily_close_error"
    }, error.status || 500);
  }
  return true;
}

async function handleProductionBatchRoute(request, response, url, user) {
  if (!url.pathname.startsWith("/api/production-batches")) return false;

  try {
    if (url.pathname === "/api/production-batches" && request.method === "GET") {
      sendJson(response, { ok: true, batches: businessStore.listProductionBatches() });
      return true;
    }
    if (url.pathname === "/api/production-batches" && request.method === "POST") {
      const payload = await readJsonBody(request);
      let sourceOrder = null;
      if (ORDER_PRODUCTION_SOURCE_TYPES.has(payload.sourceType)) {
        sourceOrder = businessStore.getSalesOrder(payload.sourceId);
        if (isCounterSaleOrder(sourceOrder)) {
          sendJson(response, {
            ok: false,
            error: "Counter sales use existing stock and cannot queue production",
            code: "counter_sale_production_forbidden"
          }, 409);
          return true;
        }
        if (!sourceOrder || ["Ready", "Completed", "Cancelled"].includes(sourceOrder.status)) {
          sendJson(response, {
            ok: false,
            error: "The linked order is unavailable or already closed",
            code: payload.sourceType === "Internal Craft" ? "internal_craft_unavailable" : "customer_order_unavailable"
          }, 409);
          return true;
        }
        if (payload.sourceType !== productionSourceTypeForOrder(sourceOrder)) {
          sendJson(response, {
            ok: false,
            error: "The production type does not match the linked order",
            code: "production_order_type_mismatch"
          }, 400);
          return true;
        }
      }
      if (!isManagementRole(user)) {
        if (!sourceOrder) {
          sendJson(response, {
            ok: false,
            error: "Employees can only queue production from a saved customer or internal craft order",
            code: "customer_order_production_required"
          }, 403);
          return true;
        }
        payload.assignedTo = sourceOrder.handler || user.fullName;
      }
      const createOperation = productionCreateQueue.then(async () => {
        const currentSourceOrder = sourceOrder ? businessStore.getSalesOrder(sourceOrder.id) : null;
        if (currentSourceOrder && businessStore.listProductionBatches().some(batch =>
          ORDER_PRODUCTION_SOURCE_TYPES.has(batch.sourceType)
          && batch.sourceId === currentSourceOrder.id
          && batch.status !== "Cancelled"
        )) {
          throw productionError("This customer order already has a fulfillment batch", 409, "production_source_active");
        }
        const prepared = await prepareProductionBatch(payload);
        if (currentSourceOrder) {
          assertProductionMatchesSalesOrder(prepared, currentSourceOrder);
          if (prepared.sourceType === "Internal Craft" && prepared.stockAllocations.length) {
            throw productionError(
              "Internal crafts must produce the full quantity and cannot reserve finished stock",
              400,
              "internal_craft_stock_allocation_forbidden"
            );
          }
          await assertProductionStockAvailable(prepared);
        }
        return businessStore.createProductionBatch(prepared, user);
      });
      productionCreateQueue = createOperation.catch(() => {});
      const batch = await createOperation;
      let order = null;
      if (ORDER_PRODUCTION_SOURCE_TYPES.has(batch.sourceType) && batch.sourceId) {
        order = businessStore.getSalesOrder(batch.sourceId);
        await recordSalesOrderAudit("sales_order.production_queued", order, user);
      }
      await recordProductionBatchAudit("production_batch.created", batch, user);
      sendJson(response, {
        ok: true,
        batch,
        batches: businessStore.listProductionBatches(),
        order,
        orders: businessStore.listSalesOrders()
      });
      return true;
    }

    const actionRoute = url.pathname.match(/^\/api\/production-batches\/([^/]+)\/(start|progress|cancel)$/);
    if (actionRoute && request.method === "POST") {
      const batchId = decodeURIComponent(actionRoute[1]);
      const action = actionRoute[2];
      if (action === "start") {
        const batch = await businessStore.startProductionBatch(batchId, user);
        await recordProductionBatchAudit("production_batch.started", batch, user);
        sendJson(response, { ok: true, batch, batches: businessStore.listProductionBatches() });
        return true;
      }
      if (action === "progress") {
        const payload = await readJsonBody(request);
        const operation = productionProgressQueue.then(() => recordProductionProgress(batchId, payload, user));
        productionProgressQueue = operation.catch(() => {});
        sendJson(response, await operation);
        return true;
      }
      if (!requireManagement(response, user)) return true;
      const batch = await businessStore.cancelProductionBatch(batchId, user);
      if (ORDER_PRODUCTION_SOURCE_TYPES.has(batch.sourceType) && batch.sourceId) {
        const order = businessStore.getSalesOrder(batch.sourceId);
        await recordSalesOrderAudit("sales_order.production_cancelled", order, user);
      }
      await recordProductionBatchAudit("production_batch.cancelled", batch, user);
      sendJson(response, {
        ok: true,
        batch,
        batches: businessStore.listProductionBatches(),
        orders: businessStore.listSalesOrders()
      });
      return true;
    }

    sendJson(response, { ok: false, error: "Production batch route not found", code: "not_found" }, 404);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Production batch request failed",
      code: error.code || "production_batch_error"
    }, error.status || 500);
  }
  return true;
}

async function prepareProductionBatch(input) {
  const snapshot = await readSheetSnapshot();
  const catalog = mergeCatalogWithSheetProducts(businessStore.getCatalogData(), snapshot);
  const itemByKey = new Map();
  [...catalog.items, ...(Array.isArray(catalog.materials) ? catalog.materials : [])].forEach(item => {
    [item.name, item.label, item.tag, ...(Array.isArray(item.aliases) ? item.aliases : [])].forEach(value => {
      const key = inventoryKey(value);
      if (key && !itemByKey.has(key)) itemByKey.set(key, item);
    });
  });
  const rootLines = new Map();
  const ingredientSources = {};
  (Array.isArray(input.lines) ? input.lines : []).slice(0, 50).forEach(sourceLine => {
    const item = itemByKey.get(inventoryKey(sourceLine.itemName || sourceLine.name || sourceLine.itemLabel));
    if (!item) throw productionError("Production batches can only contain catalog products", 400, "production_item_unknown");
    const recipeName = Object.keys(catalog.recipes).find(name => inventoryKey(name) === inventoryKey(item.name));
    const recipe = recipeName ? catalog.recipes[recipeName] : null;
    if (!Array.isArray(recipe) || !recipe.length) {
      throw productionError(`No recipe is available for ${item.label || item.name}`, 400, "production_recipe_missing");
    }
    const quantity = Number(sourceLine.requestedQuantity || sourceLine.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw productionError("Production quantities must be positive whole numbers", 400, "invalid_production_quantity");
    }
    const existing = rootLines.get(item.name) || {
      itemName: item.name,
      itemLabel: item.label || item.name,
      requestedQuantity: 0
    };
    existing.requestedQuantity += quantity;
    rootLines.set(item.name, existing);
    Object.entries(sourceLine.ingredientSources || {}).forEach(([ingredient, sourceLocation]) => {
      ingredientSources[inventoryKey(ingredient)] = normalizeProductionSource(sourceLocation);
    });
  });
  const storageRows = storageInventoryRows(snapshot);
  const storefrontRows = Array.isArray(snapshot?.inventory?.storefront)
    ? snapshot.inventory.storefront
    : snapshot?.inventory?.products;
  const productionCounts = subtractFinishedStockReservations({
    Storage: materialStorageCounts(Array.isArray(storageRows) ? storageRows : []),
    Storefront: storefrontInventoryCounts(Array.isArray(storefrontRows) ? storefrontRows : [])
  }, input.sourceId);
  const staged = planProduction({
    lines: [...rootLines.values()],
    recipes: catalog.recipes,
    recipeYields: catalog.recipeYields,
    counts: productionCounts,
    ingredientSources,
    rootOutputLocation: input.sourceType === "Storefront Restock" ? "Storefront" : "Storage",
    maxLines: 50
  });
  const blockingIssue = staged.issues[0];
  if (blockingIssue) {
    const cycle = blockingIssue.type === "recipe_cycle";
    const tooLarge = blockingIssue.type === "line_limit";
    throw productionError(
      tooLarge
        ? "Production plan exceeds 50 stage lines"
        : cycle
        ? `Recipe cycle detected: ${blockingIssue.path.join(" -> ")}`
        : `No recipe is available for ${blockingIssue.itemName}`,
      400,
      tooLarge ? "production_plan_too_large" : cycle ? "production_recipe_cycle" : "production_recipe_missing"
    );
  }
  if (staged.buildLines.length > 50) {
    throw productionError("Production plan exceeds 50 stage lines", 400, "production_plan_too_large");
  }
  const lines = staged.buildLines.map(stageLine => {
    const recipeName = Object.keys(catalog.recipes).find(name => inventoryKey(name) === inventoryKey(stageLine.name));
    const recipe = catalog.recipes[recipeName] || [];
    const item = itemByKey.get(inventoryKey(stageLine.name));
    return {
      id: crypto.randomUUID(),
      itemName: recipeName || stageLine.name,
      itemLabel: item?.label || stageLine.name,
      requestedQuantity: stageLine.requestedQuantity,
      recipeYield: stageLine.recipeYield,
      plannedCrafts: stageLine.plannedCrafts,
      isIntermediate: stageLine.isIntermediate,
      outputLocation: stageLine.outputLocation,
      stage: stageLine.stage,
      recipe: recipe.map(([ingredient, componentQuantity, defaultSource]) => ({
        ingredient: canonicalInventoryName(ingredient),
        quantity: Number(componentQuantity || 0),
        sourceLocation: normalizeProductionSource(
          ingredientSources[inventoryKey(ingredient)] || defaultSource
        )
      }))
    };
  });
  const stockAllocations = new Map();
  (Array.isArray(input.stockAllocations) ? input.stockAllocations : []).slice(0, 50).forEach(sourceAllocation => {
    const item = itemByKey.get(inventoryKey(
      sourceAllocation.itemName || sourceAllocation.name || sourceAllocation.itemLabel
    ));
    if (!item) throw productionError("Existing-stock allocations must refer to catalog products", 400, "stock_allocation_item_unknown");
    const storageQuantity = Number(sourceAllocation.storageQuantity || 0);
    const storefrontQuantity = Number(sourceAllocation.storefrontQuantity || 0);
    if (!Number.isInteger(storageQuantity) || storageQuantity < 0
      || !Number.isInteger(storefrontQuantity) || storefrontQuantity < 0) {
      throw productionError("Existing-stock quantities must be positive whole numbers", 400, "invalid_stock_allocation_quantity");
    }
    if (storageQuantity + storefrontQuantity <= 0) return;
    const existing = stockAllocations.get(item.name) || {
      itemName: item.name,
      itemLabel: item.label || item.name,
      storageQuantity: 0,
      storefrontQuantity: 0
    };
    existing.storageQuantity += storageQuantity;
    existing.storefrontQuantity += storefrontQuantity;
    stockAllocations.set(item.name, existing);
  });
  return {
    id: String(input.id || crypto.randomUUID()),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    reference: input.reference,
    dueDate: input.dueDate,
    priority: input.priority,
    assignedTo: input.assignedTo,
    notes: input.notes,
    lines,
    stockAllocations: [...stockAllocations.values()]
  };
}

function assertProductionMatchesSalesOrder(batch, order) {
  const fulfillment = new Map();
  const addFulfillment = (itemName, itemLabel, producedQuantity, storageQuantity = 0, storefrontQuantity = 0) => {
    const key = inventoryKey(itemName || itemLabel);
    const current = fulfillment.get(key) || {
      itemName,
      itemLabel: itemLabel || itemName,
      keys: new Set(),
      producedQuantity: 0,
      storageQuantity: 0,
      storefrontQuantity: 0
    };
    [itemName, itemLabel].forEach(value => {
      const alias = inventoryKey(value);
      if (alias) current.keys.add(alias);
    });
    current.producedQuantity += Number(producedQuantity || 0);
    current.storageQuantity += Number(storageQuantity || 0);
    current.storefrontQuantity += Number(storefrontQuantity || 0);
    fulfillment.set(key, current);
  };
  batch.lines.filter(line => !line.isIntermediate)
    .forEach(line => addFulfillment(line.itemName, line.itemLabel, line.requestedQuantity));
  (batch.stockAllocations || []).forEach(allocation => addFulfillment(
    allocation.itemName,
    allocation.itemLabel,
    0,
    allocation.storageQuantity,
    allocation.storefrontQuantity
  ));

  fulfillment.forEach(entry => {
    const orderedQuantity = order.lines
      .filter(line => !line.custom && [line.name, line.label, line.tag]
        .some(value => entry.keys.has(inventoryKey(value))))
      .reduce((sum, line) => sum + Number(line.quantity || 0), 0);
    const fulfilledQuantity = entry.producedQuantity + entry.storageQuantity + entry.storefrontQuantity;
    if (!orderedQuantity || fulfilledQuantity !== orderedQuantity) {
      throw productionError(
        `Fulfillment for ${entry.itemLabel || entry.itemName} must cover the linked order exactly (${fulfilledQuantity}/${orderedQuantity})`,
        400,
        "production_order_mismatch"
      );
    }
  });
  const uncovered = order.lines.filter(line => !line.custom && Number(line.quantity || 0) > 0).filter(line =>
    ![...fulfillment.values()].some(entry => [line.name, line.label, line.tag]
      .some(value => entry.keys.has(inventoryKey(value))))
  );
  if (uncovered.length) {
    throw productionError(
      `Choose existing stock or production for ${uncovered.map(line => line.label || line.name).join(", ")}`,
      400,
      "production_order_mismatch"
    );
  }
}

async function assertProductionStockAvailable(batch) {
  if (!batch.stockAllocations?.length) return;
  const snapshot = await readSheetSnapshot();
  const storageRows = storageInventoryRows(snapshot);
  const storefrontRows = Array.isArray(snapshot?.inventory?.storefront)
    ? snapshot.inventory.storefront
    : snapshot?.inventory?.products;
  if (!snapshot?.ok || !Array.isArray(storageRows) || !Array.isArray(storefrontRows)) {
    throw productionError(
      `Inventory could not be checked${snapshot?.error ? `: ${snapshot.error}` : ""}`,
      502,
      "production_inventory_unavailable"
    );
  }
  const counts = {
    Storage: materialStorageCounts(storageRows),
    Storefront: storefrontInventoryCounts(storefrontRows)
  };
  const reserved = finishedStockReservations(batch.sourceId);
  const shortages = [];
  batch.stockAllocations.forEach(allocation => {
    const itemKey = inventoryKey(allocation.itemName || allocation.itemLabel);
    [
      ["Storage", Number(allocation.storageQuantity || 0)],
      ["Storefront", Number(allocation.storefrontQuantity || 0)]
    ].forEach(([location, wanted]) => {
      if (!wanted) return;
      const available = Math.max(0,
        Number(counts[location].get(itemKey)?.quantity || 0)
          - Number(reserved.get(`${location}:${itemKey}`) || 0)
      );
      if (available < wanted) shortages.push(`${allocation.itemLabel || allocation.itemName} in ${location} ${available}/${wanted}`);
    });
  });
  if (shortages.length) {
    throw productionError(
      `Existing stock changed before it could be reserved: ${shortages.join(", ")}`,
      409,
      "production_stock_allocation_shortage"
    );
  }
}

function finishedStockReservations(excludeOrderId = "") {
  return productionInventory.finishedStockReservations({
    batches: businessStore.listProductionBatches(),
    orders: businessStore.listSalesOrders(),
    excludeOrderId,
    itemKey: inventoryKey,
    normalizeSource: normalizeProductionSource
  });
}

function subtractFinishedStockReservations(counts, excludeOrderId = "") {
  return productionInventory.subtractInventoryReservations({
    counts,
    reservations: finishedStockReservations(excludeOrderId)
  });
}

async function syncCustomerOrderFulfillment(order, batch, user) {
  const webhookManagedLocations = await getWebhookManagedInventoryLocations();
  const movements = new Map();
  const addMovement = (location, itemName, itemLabel, quantity) => {
    const amount = Number(quantity || 0);
    if (amount <= 0) return;
    const key = `${location}:${inventoryKey(itemName || itemLabel)}`;
    const current = movements.get(key) || {
      location,
      itemName,
      itemLabel: itemLabel || itemName,
      quantity: 0
    };
    current.quantity += amount;
    movements.set(key, current);
  };
  (batch.stockAllocations || []).forEach(allocation => {
    addMovement("Storage", allocation.itemName, allocation.itemLabel, allocation.storageQuantity);
    addMovement("Storefront", allocation.itemName, allocation.itemLabel, allocation.storefrontQuantity);
  });
  batch.lines.filter(line => !line.isIntermediate).forEach(line => {
    addMovement("Storage", line.itemName, line.itemLabel, line.requestedQuantity);
  });

  for (const movement of [...movements.values()].sort((left, right) =>
    left.location.localeCompare(right.location) || left.itemName.localeCompare(right.itemName)
  )) {
    if (webhookManagedLocations.has(movement.location)) continue;
    const fingerprint = `${order.id}:${batch.id}:${movement.location}:${inventoryKey(movement.itemName)}`;
    const entry = {
      id: `fulfillment-${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 28)}`,
      kind: "Correction Out",
      location: movement.location,
      itemName: movement.itemName,
      itemLabel: movement.itemLabel,
      quantity: movement.quantity,
      amount: 0,
      note: `Customer order delivered: ${order.customer || order.id}`,
      employee: user.fullName,
      createdAt: new Date().toISOString()
    };
    const result = await syncGuiPayload({ action: "manual_operation", entry });
    if (!result.ok) {
      throw salesOrderError(
        `Delivery stock update paused: ${result.error || "unknown error"}. Complete the order again to retry safely.`,
        502,
        "sales_order_fulfillment_sync_pending"
      );
    }
  }
}

function salesOrderProductionShape(order) {
  const lines = (Array.isArray(order?.lines) ? order.lines : []).map(line => ({
    key: inventoryKey(line.name || line.label || line.tag),
    quantity: Number(line.quantity || 0)
  })).sort((left, right) => left.key.localeCompare(right.key) || left.quantity - right.quantity);
  return JSON.stringify({
    orderType: order?.orderType === "Internal Craft"
      ? "Internal Craft"
      : order?.orderType === "Counter Sale" ? "Counter Sale" : "Customer Sale",
    customerId: String(order?.customerId || ""),
    customer: String(order?.customer || "").trim(),
    handler: String(order?.handler || "").trim(),
    priority: order?.priority === "Expedite" ? "Expedite" : "Normal",
    deliveryDate: String(order?.deliveryDate || ""),
    lines
  });
}

async function recordProductionProgress(batchId, payload, user) {
  let batch = businessStore.getProductionBatch(batchId);
  if (!batch) throw productionError("Production batch not found", 404, "not_found");

  if (!batch.pendingProgress) {
    const pending = await prepareProductionProgress(batch, payload, user);
    batch = await businessStore.beginProductionProgress(batchId, pending, user);
  }
  const pending = batch.pendingProgress;
  for (const entry of pending.operations) {
    const result = await syncGuiPayload({ action: "manual_operation", entry });
    if (!result.ok) {
      throw productionError(
        `Data update paused: ${result.error || "unknown error"}. The same progress is saved and can be retried safely.`,
        502,
        "production_sync_pending"
      );
    }
  }

  const updated = await businessStore.commitProductionProgress(batchId, pending.id, user);
  let order = null;
  if (updated.status === "Completed" && ORDER_PRODUCTION_SOURCE_TYPES.has(updated.sourceType) && updated.sourceId) {
    order = businessStore.getSalesOrder(updated.sourceId);
    await recordSalesOrderAudit(
      updated.sourceType === "Internal Craft" ? "sales_order.internal_craft_completed" : "sales_order.production_ready",
      order,
      user
    );
  }
  const auditAction = updated.status === "Completed" ? "production_batch.completed" : "production_batch.progressed";
  await recordProductionBatchAudit(auditAction, updated, user, pending);
  return {
    ok: true,
    batch: updated,
    batches: businessStore.listProductionBatches(),
    order,
    orders: businessStore.listSalesOrders()
  };
}

async function prepareProductionProgress(batch, payload, user) {
  const webhookManagedLocations = await getWebhookManagedInventoryLocations();
  const requested = new Map((Array.isArray(payload.completions) ? payload.completions : [])
    .map(completion => [String(completion.lineId || ""), Number(completion.completedCrafts)]));
  const targets = [];
  const operations = [];
  const previousCrafts = new Map(batch.lines.map(line => [line.id, Number(line.completedCrafts || 0)]));
  const targetCrafts = new Map(previousCrafts);

  batch.lines.forEach(line => {
    if (!requested.has(line.id)) return;
    const completedCrafts = requested.get(line.id);
    if (!Number.isInteger(completedCrafts)
      || completedCrafts <= Number(line.completedCrafts || 0)
      || completedCrafts > Number(line.plannedCrafts || 0)) {
      throw productionError("Completed craft cycles must increase without exceeding the plan", 400, "invalid_production_progress");
    }
    const prior = Number(line.completedCrafts || 0);
    targets.push({ lineId: line.id, previousCrafts: prior, completedCrafts });
    targetCrafts.set(line.id, completedCrafts);
  });
  if (!targets.length) {
    throw productionError("Enter at least one newly completed craft cycle", 400, "production_progress_required");
  }

  const before = productionInventoryState(batch, previousCrafts);
  const after = productionInventoryState(batch, targetCrafts);
  const fingerprint = targets
    .map(target => `${target.lineId}:${target.previousCrafts}:${target.completedCrafts}`)
    .sort()
    .join("|");
  const requiredMaterials = new Map();
  after.uses.forEach((requirement, key) => {
    const quantity = Number(requirement.quantity || 0) - Number(before.uses.get(key)?.quantity || 0);
    if (quantity < -0.000001) {
      throw productionError(
        `Complete intermediate production before dependent products for ${requirement.itemName}`,
        409,
        "production_stage_order"
      );
    }
    if (quantity <= 0) return;
    requiredMaterials.set(key, { ...requirement, quantity });
    if (!webhookManagedLocations.has(requirement.sourceLocation)) {
      operations.push(productionAggregateOperation({
        batch,
        fingerprint,
        suffix: `use:${key}`,
        kind: "Production Use",
        itemName: requirement.itemName,
        quantity,
        location: requirement.sourceLocation,
        employee: user.fullName
      }));
    }
  });
  after.outputs.forEach((output, key) => {
    const quantity = Number(output.quantity || 0) - Number(before.outputs.get(key)?.quantity || 0);
    if (quantity <= 0) return;
    if (batch.sourceType === "Storefront Restock" && output.rootOutput) return;
    if (webhookManagedLocations.has(output.outputLocation)) return;
    operations.push(productionAggregateOperation({
      batch,
      fingerprint,
      suffix: `output:${key}`,
      kind: "Production Output",
      itemName: output.itemName,
      itemLabel: output.itemLabel,
      quantity,
      location: output.outputLocation,
      employee: user.fullName
    }));
  });

  const snapshot = await readSheetSnapshot();
  const storageRows = storageInventoryRows(snapshot);
  const storefrontRows = Array.isArray(snapshot?.inventory?.storefront)
    ? snapshot.inventory.storefront
    : snapshot?.inventory?.products;
  if (!snapshot?.ok || !Array.isArray(storageRows) || !Array.isArray(storefrontRows)) {
    throw productionError(
      `Inventory could not be checked${snapshot?.error ? `: ${snapshot.error}` : ""}`,
      502,
      "production_inventory_unavailable"
    );
  }
  const storage = materialStorageCounts(storageRows);
  const storefront = storefrontInventoryCounts(storefrontRows);
  const reservedBefore = productionReservationsBefore(batch.id);
  const shortages = [...requiredMaterials.entries()].filter(([, requirement]) =>
    !webhookManagedLocations.has(requirement.sourceLocation)
  ).map(([key, requirement]) => ({
    ...requirement,
    available: Math.max(0,
      Number((requirement.sourceLocation === "Storefront" ? storefront : storage).get(inventoryKey(requirement.itemName))?.quantity || 0)
        - Number(reservedBefore.get(key) || 0)
    )
  })).filter(requirement => requirement.available < requirement.quantity);
  if (shortages.length) {
    const summary = shortages.map(line => `${line.itemName} in ${line.sourceLocation} ${line.available}/${line.quantity}`).join(", ");
    throw productionError(`Not enough selected stock for production: ${summary}`, 409, "production_material_shortage");
  }

  return {
    id: crypto.randomUUID(),
    targets,
    operations,
    inventoryManagedExternally: operations.length === 0 && webhookManagedLocations.size > 0,
    createdAt: new Date().toISOString(),
    createdBy: user.fullName
  };
}

async function getWebhookManagedInventoryLocations() {
  const locations = new Set();
  if (!hostedMode || !tenantManager) return locations;
  const integration = await tenantManager.getDiscordIntegration(currentTenantContext().businessId);
  if (integration?.eventChannelId) locations.add("Storefront");
  if (integration?.storageLedgerChannelId) locations.add("Storage");
  return locations;
}

function productionReservationsBefore(batchId) {
  const reserved = new Map(finishedStockReservations());
  for (const batch of businessStore.listProductionBatches()) {
    if (batch.id === batchId) break;
    if (batch.status !== "Planned" && batch.status !== "In Progress") continue;
    const current = productionInventoryState(batch, new Map(batch.lines.map(line => [line.id, Number(line.completedCrafts || 0)])));
    const planned = productionInventoryState(batch, new Map(batch.lines.map(line => [line.id, Number(line.plannedCrafts || 0)])));
    planned.uses.forEach((requirement, key) => {
      const remaining = Math.max(0, Number(requirement.quantity || 0) - Number(current.uses.get(key)?.quantity || 0));
      reserved.set(key, Number(reserved.get(key) || 0) + remaining);
    });
  }
  return reserved;
}

function productionInventoryState(batch, craftsByLine) {
  return productionInventory.productionInventoryState(batch, craftsByLine, {
    itemKey: inventoryKey,
    canonicalItemName: canonicalInventoryName,
    normalizeSource: normalizeProductionSource
  });
}

function productionError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function reconcileStorefrontBuyOrdersFromSheet(sheetSnapshot = null) {
  const snapshot = sheetSnapshot || await readSheetSnapshot();
  const purchases = snapshot?.inventory?.buyOrderPurchases;
  if (Array.isArray(purchases)) await businessStore.reconcileStorefrontBuyOrders(purchases);
  return snapshot;
}

async function receiveSupplyOrder(orderId, payload, user) {
  const webhookManagedLocations = await getWebhookManagedInventoryLocations();
  const storageManagedExternally = webhookManagedLocations.has("Storage");
  const requestedReceipts = Array.isArray(payload.receipts) ? payload.receipts.slice(0, 100) : [];
  if (!requestedReceipts.length) {
    throw supplyOrderError("Enter at least one quantity to receive", 400, "receipts_required");
  }

  const order = businessStore.getSupplyOrder(orderId);
  if (!order) throw supplyOrderError("Supply order not found", 404, "not_found");
  if (order.status !== "Ordered" && order.status !== "Partially Received") {
    throw supplyOrderError("Only ordered supplies can be received", 409, "order_not_receivable");
  }

  const seenLineIds = new Set();
  requestedReceipts.forEach(receipt => {
    const lineId = String(receipt.lineId || "").trim();
    const line = order.lines.find(candidate => candidate.id === lineId);
    const quantity = Number(receipt.quantity);
    if (!line) throw supplyOrderError("Supply order line not found", 404, "line_not_found");
    if (seenLineIds.has(lineId)) {
      throw supplyOrderError("Each material can only appear once in a receipt", 400, "duplicate_receipt_line");
    }
    const remaining = Math.max(0, Number(line.quantity || 0) - Number(line.receivedQuantity || 0));
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > remaining) {
      throw supplyOrderError(`Receipt for ${line.label || line.name} must be between 1 and ${remaining}`, 400, "invalid_receipt_quantity");
    }
    seenLineIds.add(lineId);
  });

  const sheetSnapshot = await readSheetSnapshot();
  const storageRows = storageInventoryRows(sheetSnapshot);
  if ((!sheetSnapshot?.ok || !Array.isArray(storageRows)) && !storageManagedExternally) {
    throw supplyOrderError(
      `Storage could not be read from the shared data service${sheetSnapshot?.error ? `: ${sheetSnapshot.error}` : ""}`,
      502,
      "storage_snapshot_unavailable"
    );
  }
  const storage = materialStorageCounts(Array.isArray(storageRows) ? storageRows : []);
  const processed = [];
  let updatedOrder = order;

  for (const requested of requestedReceipts) {
    const currentOrder = businessStore.getSupplyOrder(orderId);
    const line = currentOrder.lines.find(candidate => candidate.id === String(requested.lineId || "").trim());
    const quantity = Number(requested.quantity);
    const previouslyReceived = Number(line.receivedQuantity || 0);
    const cumulativeReceived = previouslyReceived + quantity;
    const key = inventoryKey(line.name || line.label);
    const currentStorage = storage.get(key) || { quantity: 0, name: canonicalInventoryName(line.name || line.label) };
    const absoluteCount = Number(currentStorage.quantity || 0) + (storageManagedExternally ? 0 : quantity);
    const operationId = `supply-receipt:${orderId}:${line.id}:${cumulativeReceived}`;
    const itemName = currentStorage.name || canonicalInventoryName(line.name || line.label);
    if (!storageManagedExternally) {
      const syncResult = await syncGuiPayload({
        action: "manual_operation",
        entry: {
          id: operationId,
          createdAt: new Date().toISOString(),
          kind: "Stock Count",
          location: "Storage",
          itemName,
          itemLabel: itemName,
          itemTag: "",
          quantity: absoluteCount,
          employee: user.fullName,
          amount: "",
          note: `Received ${quantity} from ${currentOrder.producer} / supply order ${currentOrder.id}`
        }
      });
      if (!syncResult?.ok) {
        throw supplyOrderError(
          `Storage update failed for ${line.label || line.name}: ${syncResult?.error || "The data service rejected the receipt"}`,
          502,
          "supply_receipt_sync_failed"
        );
      }
    }

    updatedOrder = await businessStore.receiveSupplyLine(orderId, line.id, quantity, user, {
      id: operationId,
      receivedAt: new Date().toISOString(),
      unitPrice: line.unitPrice
    });
    storage.set(key, { quantity: absoluteCount, name: itemName });
    const receipt = {
      id: operationId,
      lineId: line.id,
      itemName,
      quantity,
      receivedQuantity: cumulativeReceived,
      storageCount: absoluteCount,
      inventoryManagedExternally: storageManagedExternally
    };
    processed.push(receipt);
    await recordSupplyReceiptAudit(updatedOrder, line, receipt, user);
  }

  return { ok: true, order: updatedOrder, orders: businessStore.listSupplyOrders(), receipts: processed };
}

function materialStorageCounts(materials) {
  const counts = new Map();
  materials.forEach(material => {
    const name = material.ingredient || material.itemName || material.itemLabel || material.name;
    const key = inventoryKey(name);
    if (!key) return;
    counts.set(key, {
      quantity: Number.isFinite(Number(material.storageCount)) ? Number(material.storageCount) : 0,
      name: canonicalInventoryName(name)
    });
  });
  return counts;
}

function storefrontInventoryCounts(items) {
  const counts = new Map();
  items.forEach(item => {
    const name = item.itemName || item.itemLabel || item.ingredient || item.name;
    const key = inventoryKey(name);
    if (!key) return;
    counts.set(key, {
      quantity: Number.isFinite(Number(item.currentStock)) ? Number(item.currentStock) : 0,
      name: canonicalInventoryName(name)
    });
  });
  return counts;
}

function normalizeProductionSource(value) {
  return productionInventory.normalizeProductionSource(value, { itemKey: inventoryKey });
}

function inventoryKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return key === "wood" || key === "soft wood" || key === "softwood" ? "softwood" : key;
}

function canonicalInventoryName(value) {
  return inventoryKey(value) === "softwood" ? "Softwood" : String(value || "").trim();
}

function supplyOrderError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function recordSupplyOrderAudit(action, order, user) {
  if (!accountStore) return;
  await accountStore.recordAudit({
    category: "procurement",
    action,
    actorId: user.id,
    actorName: user.fullName,
    subjectId: order.id,
    subjectName: order.producer,
    fingerprint: `${action}:${order.id}:${order.updatedAt}`,
    details: {
      producer: order.producer,
      status: order.status,
      lineCount: order.lines.length,
      total: order.lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0)
    }
  });
}

async function recordSalesOrderAudit(action, order, user) {
  if (!accountStore) return;
  await accountStore.recordAudit({
    category: "sales",
    action,
    actorId: user.id,
    actorName: user.fullName,
    subjectId: order.id,
    subjectName: salesOrderDisplayName(order),
    fingerprint: `${action}:${order.id}:${order.revision}`,
    details: {
      orderType: order.orderType,
      status: order.status,
      priority: order.priority,
      handler: order.handler,
      lineCount: order.lines.length,
      subtotal: order.lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0),
      revision: order.revision
    }
  });
}

async function recordSalesOrderImportAudit(result, user) {
  if (!accountStore || !result.imported) return;
  await accountStore.recordAudit({
    category: "sales",
    action: "sales_order.imported",
    actorId: user.id,
    actorName: user.fullName,
    subjectId: user.id,
    subjectName: user.fullName,
    fingerprint: `sales_order.imported:${user.id}:${result.imported}:${Date.now()}`,
    details: {
      imported: result.imported,
      skipped: result.skipped
    }
  });
}

async function recordDailyCloseAudit(action, close, user) {
  if (!accountStore) return;
  const difference = Number.isFinite(close.countedLedgerBalance) && Number.isFinite(close.snapshot?.ledgerBalance)
    ? close.countedLedgerBalance - close.snapshot.ledgerBalance
    : null;
  await accountStore.recordAudit({
    category: "reconciliation",
    action,
    actorId: user.id,
    actorName: user.fullName,
    subjectId: close.id,
    subjectName: close.businessDate,
    fingerprint: `${action}:${close.id}:${close.revision}`,
    details: {
      status: close.status,
      revision: close.revision,
      ledgerDifference: difference,
      storefrontConfirmed: close.storefrontConfirmed,
      storageConfirmed: close.storageConfirmed,
      openIssues: close.snapshot?.issues?.length || 0
    }
  });
}

async function recordStorefrontBuyOrderAudit(action, order, user) {
  if (!accountStore) return;
  await accountStore.recordAudit({
    category: "procurement",
    action,
    actorId: user.id,
    actorName: user.fullName,
    subjectId: order.id,
    subjectName: order.itemLabel || order.itemName,
    details: {
      status: order.status,
      quantity: order.quantity,
      filledQuantity: order.filledQuantity,
      unitPrice: order.unitPrice
    }
  });
}

async function recordSupplierAudit(action, supplier, user) {
  if (!accountStore) return;
  await accountStore.recordAudit({
    category: "procurement",
    action,
    actorId: user.id,
    actorName: user.fullName,
    subjectId: supplier.id,
    subjectName: supplier.name,
    fingerprint: `${action}:${supplier.id}:${supplier.updatedAt}`,
    details: {
      category: supplier.category,
      location: supplier.location,
      products: supplier.products.length,
      employeeContacts: supplier.employees.length
    }
  }).catch(error => console.error("Unable to write supplier audit event:", error.message));
}

function productionAggregateOperation({ batch, fingerprint, suffix, kind, itemName, itemLabel, quantity, location, employee }) {
  const id = `production-${crypto.createHash("sha256")
    .update(`${batch.id}:${fingerprint}:${suffix}`)
    .digest("hex").slice(0, 28)}`;
  return {
    id,
    kind,
    location,
    itemName,
    itemLabel: itemLabel || itemName,
    quantity,
    amount: 0,
    employee,
    note: `Production batch ${batch.reference || batch.id}: ${itemLabel || itemName}`
  };
}

async function recordCustomerAudit(action, customer, user) {
  if (!accountStore) return;
  await accountStore.recordAudit({
    category: "sales",
    action,
    actorId: user.id,
    actorName: user.fullName,
    subjectId: customer.id,
    subjectName: customer.name,
    fingerprint: `${action}:${customer.id}:${customer.updatedAt}`,
    details: {
      customerType: customer.customerType,
      location: customer.location,
      orderCount: Number(customer.stats?.orderCount || 0),
      completedSales: Number(customer.stats?.completedSales || 0),
      lifetimeSales: Number(customer.stats?.lifetimeSales || 0)
    }
  }).catch(error => console.error("Unable to write customer audit event:", error.message));
}

async function recordProductionBatchAudit(action, batch, user, progress = null) {
  if (!accountStore) return;
  const plannedCrafts = batch.lines.reduce((sum, line) => sum + Number(line.plannedCrafts || 0), 0);
  const completedCrafts = batch.lines.reduce((sum, line) => sum + Number(line.completedCrafts || 0), 0);
  const existingStockUnits = (batch.stockAllocations || []).reduce((sum, allocation) =>
    sum + Number(allocation.storageQuantity || 0) + Number(allocation.storefrontQuantity || 0), 0);
  const progressedCrafts = (progress?.targets || []).reduce((sum, target) => {
    return sum + Math.max(0, Number(target.completedCrafts || 0) - Number(target.previousCrafts || 0));
  }, 0);
  await accountStore.recordAudit({
    category: "production",
    action,
    actorId: user.id,
    actorName: user.fullName,
    subjectId: batch.id,
    subjectName: batch.reference || batch.sourceType,
    fingerprint: `${action}:${batch.id}:${progress?.id || batch.updatedAt}`,
    details: {
      status: batch.status,
      sourceType: batch.sourceType,
      reference: batch.reference,
      lineCount: batch.lines.length,
      existingStockUnits,
      plannedCrafts,
      completedCrafts,
      progressedCrafts,
      assignedTo: batch.assignedTo
    }
  });
}

async function recordSupplyReceiptAudit(order, line, receipt, user) {
  if (!accountStore) return;
  await accountStore.recordAudit({
    category: "procurement",
    action: "supply_order.received",
    actorId: user.id,
    actorName: user.fullName,
    subjectId: order.id,
    subjectName: order.producer,
    fingerprint: receipt.id,
    details: {
      producer: order.producer,
      status: order.status,
      item: line.label || line.name,
      quantity: receipt.quantity,
      unitPrice: line.unitPrice,
      amount: roundFinanceMoney(Number(receipt.quantity || 0) * Number(line.unitPrice || 0)),
      receivedQuantity: receipt.receivedQuantity,
      storageCount: receipt.storageCount,
      inventoryManagedExternally: receipt.inventoryManagedExternally === true
    }
  });
}

function storageInventoryRows(snapshot) {
  if (Array.isArray(snapshot?.inventory?.storage)) return snapshot.inventory.storage;
  return Array.isArray(snapshot?.inventory?.materials) ? snapshot.inventory.materials : null;
}

function requiresAdmin(payload) {
  if (payload.action !== "manual_operation") return false;
  return new Set([
    "Payroll Payment",
    "Owner Capital Deposit",
    "Owner Withdrawal",
    "Safekeeping Deposit",
    "Safekeeping Withdrawal"
  ]).has(payload.entry?.kind);
}

function requiresManagement(payload) {
  return payload.action === "catalog_item"
    || payload.action === "catalog_item_update"
    || payload.action === "recipe_upsert"
    || payload.action === "recipe_delete"
    || payload.action === "stock_target"
    || payload.action === "storage_target"
    || payload.action === "manual_operation"
    || payload.action === "resolve_exception"
    || payload.action === "ignore_exception";
}

function stampEmployee(payload, user) {
  if (payload.action === "catalog_item" && payload.item) {
    payload.item.createdBy = user.fullName;
  }
  if (payload.action === "catalog_item_update" && payload.item) {
    payload.item.updatedBy = user.fullName;
  }
  if ((payload.action === "recipe_upsert" || payload.action === "recipe_delete") && payload.recipe) {
    payload.recipe.updatedBy = user.fullName;
  }
  if ((payload.action === "manual_operation" || payload.action === "time_clock") && payload.entry) {
    payload.entry.employee = user.fullName;
  }
  if ((payload.action === "resolve_exception" || payload.action === "ignore_exception") && payload.exception) {
    payload.exception.resolvedBy = user.fullName;
  }
}

async function auditGuiPayload(payload, user, syncResult) {
  if (payload.action === "catalog_item" && payload.item) {
    if (!syncResult?.ok) return;
    await accountStore.recordAudit({
      category: "catalog",
      action: "catalog.item_created",
      actorId: user.id,
      actorName: user.fullName,
      subjectId: syncResult?.item?.id || payload.item.name,
      subjectName: payload.item.label || payload.item.name,
      fingerprint: `catalog:${syncResult?.item?.id || inventoryKey(payload.item.name)}`,
      details: {
        type: payload.item.type,
        category: payload.item.category,
        itemTag: payload.item.tag,
        sheetSync: Boolean(syncResult?.ok)
      }
    });
    return;
  }
  if (payload.action === "catalog_item_update" && payload.item) {
    if (!syncResult?.ok) return;
    await accountStore.recordAudit({
      category: "catalog",
      action: "catalog.item_updated",
      actorId: user.id,
      actorName: user.fullName,
      subjectId: syncResult?.item?.id || payload.item.id,
      subjectName: payload.item.label || payload.item.name,
      fingerprint: `catalog-update:${syncResult?.item?.id || payload.item.id}:${Date.now()}`,
      details: { type: payload.item.type, category: payload.item.category, active: payload.item.active !== false }
    });
    return;
  }
  if ((payload.action === "recipe_upsert" || payload.action === "recipe_delete") && payload.recipe) {
    if (!syncResult?.ok) return;
    const removed = payload.action === "recipe_delete";
    await accountStore.recordAudit({
      category: "catalog",
      action: removed ? "catalog.recipe_removed" : "catalog.recipe_saved",
      actorId: user.id,
      actorName: user.fullName,
      subjectId: syncResult?.recipe?.id || inventoryKey(payload.recipe.productName),
      subjectName: payload.recipe.productName,
      fingerprint: `recipe:${payload.action}:${inventoryKey(payload.recipe.productName)}:${Date.now()}`,
      details: removed ? {} : { yield: payload.recipe.yield, ingredientCount: payload.recipe.ingredients?.length || 0 }
    });
    return;
  }
  if ((payload.action === "resolve_exception" || payload.action === "ignore_exception") && payload.exception) {
    const resolved = payload.action === "resolve_exception";
    await accountStore.recordAudit({
      category: "webhook",
      action: resolved ? "webhook_exception.resolved" : "webhook_exception.ignored",
      actorId: user.id,
      actorName: user.fullName,
      subjectId: payload.exception.webhookId,
      subjectName: payload.exception.cashCategory || payload.exception.itemName || payload.exception.discordItemLabel || "Webhook event",
      fingerprint: `${payload.action}:${payload.exception.webhookId}:${payload.exception.allocationId || "event"}`,
      details: {
        item: payload.exception.itemName,
        quantity: payload.exception.quantity,
        eventType: payload.exception.eventType,
        direction: payload.exception.direction,
        cashAmount: payload.exception.cashAmount,
        allocationId: payload.exception.allocationId,
        cashCategory: payload.exception.cashCategory,
        cashReference: payload.exception.cashReference,
        rememberMapping: payload.exception.rememberMapping,
        catalogItem: payload.exception.newItem?.enabled ? {
          type: payload.exception.newItem.type,
          name: payload.exception.newItem.name,
          category: payload.exception.newItem.category
        } : null,
        note: payload.exception.note,
        sheetSync: Boolean(syncResult?.ok)
      }
    });
    return;
  }
  if (payload.action === "time_clock" && payload.entry) {
    const clockedOut = Boolean(payload.entry.clockOut);
    await accountStore.recordAudit({
      category: "time_clock",
      action: clockedOut ? "clock.out" : "clock.in",
      actorId: user.id,
      actorName: user.fullName,
      subjectId: user.id,
      subjectName: user.fullName,
      fingerprint: `clock:${payload.entry.id}:${clockedOut ? "out" : "in"}`,
      details: {
        clockIn: payload.entry.clockIn,
        clockOut: payload.entry.clockOut,
        durationMinutes: payload.entry.durationMinutes,
        sheetSync: Boolean(syncResult?.ok)
      }
    });
    return;
  }
  if (payload.action === "manual_operation" && payload.entry) {
    const financeKinds = new Set([
      "Owner Capital Deposit",
      "Owner Withdrawal",
      "Safekeeping Deposit",
      "Safekeeping Withdrawal"
    ]);
    const financeEntry = financeKinds.has(payload.entry.kind);
    await accountStore.recordAudit({
      category: financeEntry ? "finance" : "operations",
      action: financeEntry ? "finance.funds_recorded" : "operation.recorded",
      actorId: user.id,
      actorName: user.fullName,
      subjectId: user.id,
      subjectName: user.fullName,
      fingerprint: `operation:${payload.entry.id}`,
      details: {
        kind: payload.entry.kind,
        location: payload.entry.location,
        item: payload.entry.itemLabel || payload.entry.itemName,
        quantity: payload.entry.quantity,
        amount: payload.entry.amount,
        note: payload.entry.note,
        sheetSync: Boolean(syncResult?.ok)
      }
    });
    return;
  }
  if ((payload.action === "stock_target" || payload.action === "storage_target") && payload.target) {
    const storageTarget = payload.action === "storage_target";
    const removed = Boolean(payload.target.deleting) || Number(payload.target.target) === 0;
    await accountStore.recordAudit({
      category: "operations",
      action: storageTarget
        ? (removed ? "storage_target.removed" : "storage_target.updated")
        : (removed ? "target.removed" : "target.updated"),
      actorId: user.id,
      actorName: user.fullName,
      subjectId: user.id,
      subjectName: user.fullName,
      fingerprint: `${storageTarget ? "storage-target" : "target"}:${payload.target.itemTag || payload.target.itemName || payload.target.itemLabel}:${payload.target.updatedAt || ""}:${removed}`,
      details: {
        item: payload.target.itemLabel || payload.target.itemName,
        target: payload.target.target,
        sheetSync: Boolean(syncResult?.ok)
      }
    });
  }
}

function serveStatic(response, pathname) {
  if (!publicFiles.has(pathname)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
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
    const headers = {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": pathname.endsWith(".html") || pathname === "/service-worker.js"
        ? "no-store"
        : "public, max-age=300"
    };
    if (pathname === "/service-worker.js") headers["Service-Worker-Allowed"] = "/";
    const body = pathname === "/service-worker.js"
      ? Buffer.concat([data, Buffer.from(`\n// release:${releaseVersion}\n`, "utf8")])
      : data;
    response.writeHead(200, headers);
    response.end(body);
  });
}

function isPublicPwaAsset(pathname) {
  return pathname === "/manifest.webmanifest"
    || pathname === "/service-worker.js"
    || pathname === "/pwa.js"
    || pathname.startsWith("/assets/operations-ledger-");
}

function isPublicAsset(pathname) {
  return pathname === "/login.html"
    || pathname === "/login.js"
    || pathname === "/styles.css"
    || pathname === "/assets/frontier-firearms-logo.png";
}

function readCookie(request, name) {
  const cookies = String(request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator === -1) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return "";
}

function createOperatorSession() {
  const payload = Buffer.from(JSON.stringify({
    role: "platform_operator",
    expiresAt: Date.now() + (4 * 60 * 60 * 1000),
    nonce: crypto.randomBytes(12).toString("base64url")
  }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", process.env.PLATFORM_ADMIN_SECRET || "")
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifyOperatorSession(token) {
  const secret = String(process.env.PLATFORM_ADMIN_SECRET || "");
  if (!platformOperations?.enabled || !token || !String(token).includes(".")) return false;
  const [payload, signature] = String(token).split(".", 2);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (!safeEqual(signature, expected)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return decoded.role === "platform_operator" && Number(decoded.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

function publicBaseUrl(request) {
  const forwardedHost = String(request.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || String(request.headers.host || "").trim();
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || (isHttps(request) ? "https" : "http");
  return host ? `${protocol}://${host}` : "";
}

function setSessionCookie(response, request, token) {
  setCookieHeaders(response, [
    sessionCookie(request, "business_session", token, SESSION_MAX_AGE_SECONDS),
    sessionCookie(request, "discord_membership_session", "", 0)
  ]);
}

function setIdentitySessionCookie(response, request, token) {
  setCookieHeaders(response, [sessionCookie(
    request,
    "discord_identity_session",
    token,
    IDENTITY_SESSION_MAX_AGE_SECONDS
  )]);
}

function setDiscordMembershipCookie(response, request, token) {
  setCookieHeaders(response, [
    sessionCookie(request, "discord_membership_session", token, MEMBERSHIP_SESSION_MAX_AGE_SECONDS),
    sessionCookie(request, "business_session", "", 0)
  ]);
}

function setLocalIdentitySessionCookie(response, request, token) {
  setCookieHeaders(response, [sessionCookie(
    request,
    "local_identity_session",
    token,
    LOCAL_IDENTITY_SESSION_MAX_AGE_SECONDS
  )]);
}

function clearAllSessionCookies(response, request) {
  setCookieHeaders(response, [
    sessionCookie(request, "business_session", "", 0),
    sessionCookie(request, "discord_membership_session", "", 0),
    sessionCookie(request, "discord_identity_session", "", 0),
    sessionCookie(request, "local_identity_session", "", 0)
  ]);
}

function sessionCookie(request, name, value, maxAge) {
  const secure = isHttps(request) ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function setCookieHeaders(response, values) {
  const existing = response.getHeader("Set-Cookie");
  const current = Array.isArray(existing) ? existing : existing ? [existing] : [];
  response.setHeader("Set-Cookie", [...current, ...values]);
}

function isHttps(request) {
  return process.env.NODE_ENV === "production"
    || String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function redirect(response, location) {
  response.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  response.end();
}

function allowAuthAttempt(request) {
  const now = Date.now();
  const windowStart = now - 15 * 60 * 1000;
  const key = String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
  const attempts = (loginAttempts.get(key) || []).filter(timestamp => timestamp > windowStart);
  attempts.push(now);
  loginAttempts.set(key, attempts);
  if (loginAttempts.size > 500) {
    for (const [candidate, timestamps] of loginAttempts) {
      if (!timestamps.some(timestamp => timestamp > windowStart)) loginAttempts.delete(candidate);
    }
  }
  return attempts.length <= 20;
}

function isAuthorized(request) {
  const header = String(request.headers.authorization || "");
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return false;

  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator === -1) return false;
    return safeEqual(decoded.slice(0, separator), authUser)
      && safeEqual(decoded.slice(separator + 1), authPassword);
  } catch {
    return false;
  }
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

if (require.main === module) {
  startServer().catch(error => {
    console.error("Unable to start business operations app:", error.message);
    process.exitCode = 1;
  });
}

function routeError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function staffStatusOrder(status) {
  return ({ pending: 0, active: 1, disabled: 2, rejected: 3 })[status] ?? 4;
}

async function startServer() {
  if (database.enabled && !process.env.AUTH_SESSION_SECRET) {
    throw new Error("AUTH_SESSION_SECRET is required when DATABASE_URL is configured");
  }
  await database.initialize();
  if (!hostedMode) {
    await defaultContext.businessStore.initialize();
    if (accountAuthEnabled) {
      await defaultContext.accountStore.initialize({
        adminFullName: process.env.ADMIN_FULL_NAME || "",
        adminPassword: process.env.ADMIN_PASSWORD || ""
      });
    }
    if (defaultContext.standaloneStore && defaultContext.businessStore.isConfigured()) {
      await defaultContext.standaloneStore.syncCatalog(defaultContext.businessStore.getConfiguration());
      await Promise.all([
        defaultContext.standaloneStore.reconcileImportedFundAudit(defaultContext.accountStore.listAudit(1000)),
        defaultContext.standaloneStore.reconcileCatalogPricesFromWebhooks(),
        defaultContext.standaloneStore.reconcileImportedExceptions()
      ]);
      await defaultContext.standaloneStore.reconcileStorageManagerExceptions();
    }
  }
  server.listen(port, () => {
    const backend = hostedMode
      ? "hosted multi-business PostgreSQL"
      : standaloneStore ? "PostgreSQL" : "legacy Apps Script/file storage";
    console.log(`Business operations app running at http://localhost:${port} with personal accounts and ${backend}`);
  });
}

function resolveSessionSecret(dataDirectory, configuredSecret) {
  if (configuredSecret) return { value: configuredSecret, persistent: true };
  const secretPath = path.join(dataDirectory, "session-secret");
  try {
    fs.mkdirSync(dataDirectory, { recursive: true });
    if (fs.existsSync(secretPath)) {
      const existing = fs.readFileSync(secretPath, "utf8").trim();
      if (existing) return { value: existing, persistent: true };
    }
    const generated = crypto.randomBytes(48).toString("base64url");
    fs.writeFileSync(secretPath, `${generated}\n`, { mode: 0o600, flag: "wx" });
    return { value: generated, persistent: true };
  } catch (error) {
    console.warn(`Session secret is temporary because it could not be persisted: ${error.message}`);
    return { value: crypto.randomBytes(48).toString("base64url"), persistent: false };
  }
}

function sendJson(response, payload, status = payload.ok === false ? 503 : 200) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  if (request.__businessJsonBody) return request.__businessJsonBody;
  request.__businessJsonBody = new Promise(resolve => {
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
  return request.__businessJsonBody;
}

async function getBootstrapData(user) {
  const sheetSnapshot = await readSheetSnapshot();
  const configuration = businessStore.getConfiguration();
  const data = mergeCatalogWithSheetProducts(businessStore.getCatalogData(), sheetSnapshot);
  const canManage = !user || isManagementRole(user);
  if (canManage) await reconcileStorefrontBuyOrdersFromSheet(sheetSnapshot);
  if (sheetSnapshot?.inventory) delete sheetSnapshot.inventory.buyOrderPurchases;
  if (!canManage && sheetSnapshot) {
    delete sheetSnapshot.reviewExceptions;
    delete sheetSnapshot.webhookLog;
    if (sheetSnapshot.inventory) delete sheetSnapshot.inventory.ledger;
  }
  const allDailyCloses = businessStore.listDailyCloses();
  const dailyCloses = canManage
    ? allDailyCloses
    : allDailyCloses
      .filter(close => close.status === "Finalized")
      .slice(0, 20)
      .map(employeeDailyCloseView);
  return {
    source: standaloneStore
      ? "postgresql-and-business-configuration"
      : sheetSnapshot ? "apps-script-and-business-configuration" : "business-configuration",
    generatedAt: new Date().toISOString(),
    user,
    workspace: hostedMode ? publicWorkspace() : null,
    business: configuration?.business || null,
    terminology: configuration?.terminology || null,
    navigation: configuration?.navigation || null,
    locations: configuration?.locations || [],
    modules: configuration?.modules || {},
    dataBackend: standaloneStore ? "postgresql" : "apps-script",
    sheetConfigured: !standaloneStore && Boolean(process.env.APPS_SCRIPT_URL),
    sheet: sheetSnapshot,
    categories: data.categories,
    items: data.items,
    recipeCount: Object.keys(data.recipes).length,
    recipes: data.recipes,
    recipeYields: data.recipeYields,
    materials: data.materials,
    pricing: data.pricing,
    salesOrders: businessStore.listSalesOrders(),
    customers: businessStore.listCustomers(),
    storefrontBuyOrders: canManage ? businessStore.listStorefrontBuyOrders() : [],
    productionBatches: businessStore.listProductionBatches(),
    dailyCloses,
    syncTargets: {
      stockCounts: "/api/sync",
      manualMovements: "/api/sync",
      ledgerAdjustments: "/api/sync",
      stockTargets: "/api/sync",
      storageTargets: "/api/sync",
      timeClock: "/api/sync",
      supplyOrders: "/api/supply-orders",
      storefrontBuyOrders: "/api/storefront-buy-orders",
      webhookReview: "/api/sync",
      productionBatches: "/api/production-batches",
      salesOrders: "/api/sales-orders",
      customers: "/api/customers",
      dailyCloses: "/api/daily-closes",
      finance: "/api/finance"
    }
  };
}

function employeeDailyCloseView(close) {
  const snapshot = close?.snapshot || {};
  return {
    id: close.id,
    businessDate: close.businessDate,
    status: close.status,
    handoffNotes: close.handoffNotes || "",
    priorityNotes: close.priorityNotes || "",
    snapshot: {
      capturedAt: snapshot.capturedAt || "",
      openSalesOrders: Number(snapshot.openSalesOrders || 0),
      activeProductionBatches: Number(snapshot.activeProductionBatches || 0),
      issues: Array.isArray(snapshot.issues) ? snapshot.issues : []
    },
    finalizedAt: close.finalizedAt || "",
    finalizedBy: close.finalizedBy || ""
  };
}

async function buildDailyCloseSnapshot() {
  const capturedAt = new Date().toISOString();
  const businessDate = businessDateKey(capturedAt);
  const sheet = await readSheetSnapshot();
  const inventory = sheet?.inventory || {};
  const activeSalesOrders = businessStore.listSalesOrders()
    .filter(order => order.status !== "Completed" && order.status !== "Cancelled");
  const overdueSalesOrders = activeSalesOrders.filter(order => order.deliveryDate && order.deliveryDate < businessDate);
  const activeProductionBatches = businessStore.listProductionBatches()
    .filter(batch => batch.status === "Planned" || batch.status === "In Progress");
  const expectedSupplyDeliveries = businessStore.listSupplyOrders()
    .filter(order => order.status === "Ordered" || order.status === "Partially Received")
    .filter(order => order.expectedDate && order.expectedDate <= businessDate);
  const openStorefrontBuyOrders = businessStore.listStorefrontBuyOrders()
    .filter(order => order.status === "Active" || order.status === "Paused");
  const openReviewExceptions = (Array.isArray(sheet?.reviewExceptions) ? sheet.reviewExceptions : [])
    .filter(exception => exception.status === "Open");

  const issues = [
    ...overdueSalesOrders.map(order => ({
      type: isInternalCraftOrder(order) ? "Overdue Internal Craft" : "Overdue Sale",
      label: salesOrderDisplayName(order),
      detail: `${order.status} / due ${order.deliveryDate}`
    })),
    ...activeSalesOrders.filter(order => order.priority === "Expedite" || order.status === "Paused").map(order => ({
      type: order.status === "Paused"
        ? (isInternalCraftOrder(order) ? "Paused Internal Craft" : "Paused Sale")
        : (isInternalCraftOrder(order) ? "Expedited Internal Craft" : "Expedited Sale"),
      label: salesOrderDisplayName(order),
      detail: order.deliveryDate ? `Due ${order.deliveryDate}` : (isInternalCraftOrder(order) ? "No target date" : "In-store order")
    })),
    ...activeProductionBatches.map(batch => ({
      type: "Production",
      label: batch.reference || batch.sourceType,
      detail: `${batch.status}${batch.dueDate ? ` / due ${batch.dueDate}` : ""}`
    })),
    ...expectedSupplyDeliveries.map(order => ({
      type: "Supply Delivery",
      label: order.producer || "Unassigned producer",
      detail: `${order.status} / expected ${order.expectedDate}`
    })),
    ...openStorefrontBuyOrders.map(order => ({
      type: "Storefront Buy Order",
      label: order.itemLabel || order.itemName,
      detail: `${Number(order.filledQuantity || 0)} of ${Number(order.quantity || 0)} filled`
    })),
    ...openReviewExceptions.slice(0, 20).map(exception => ({
      type: "Webhook Review",
      label: exception.discordItemLabel || exception.discordItemName || "Unrecognized event",
      detail: exception.reason || "Needs review"
    }))
  ];

  const storageRows = Array.isArray(inventory.storage) && inventory.storage.length
    ? inventory.storage
    : inventory.materials;
  return {
    capturedAt,
    sheetGeneratedAt: sheet?.generatedAt || "",
    storefrontUnits: sumInventorySnapshot(inventory.products, ["currentStock", "quantity"]),
    storageUnits: sumInventorySnapshot(storageRows, ["storageCount", "quantity"]),
    ledgerBalance: finiteOrNull(inventory.ledger?.balance),
    openSalesOrders: activeSalesOrders.length,
    overdueSalesOrders: overdueSalesOrders.length,
    activeProductionBatches: activeProductionBatches.length,
    expectedSupplyDeliveries: expectedSupplyDeliveries.length,
    openStorefrontBuyOrders: openStorefrontBuyOrders.length,
    openReviewExceptions: openReviewExceptions.length,
    issues
  };
}

function sumInventorySnapshot(rows, fields) {
  if (!Array.isArray(rows)) return null;
  const counts = new Map();
  rows.forEach(row => {
    const key = inventoryKey(row?.itemName || row?.itemLabel || row?.ingredient || row?.name);
    if (!key) return;
    const field = fields.find(candidate => Number.isFinite(Number(row?.[candidate])));
    if (!field) return;
    counts.set(key, Math.max(0, Number(row[field])));
  });
  return [...counts.values()].reduce((sum, value) => sum + value, 0);
}

function finiteOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function businessDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: process.env.BUSINESS_TIME_ZONE || "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const byType = new Map(parts.map(part => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

async function readSheetSnapshot() {
  if (standaloneStore) return standaloneStore.snapshot();
  return readAppsScriptAction("bootstrap");
}

async function readAppsScriptAction(action, parameters = {}) {
  if (standaloneStore) {
    if (action === "bootstrap") return standaloneStore.snapshot();
    if (action === "finance") return standaloneStore.finance(parameters);
    return { ok: false, error: `Unsupported database read action: ${action}` };
  }
  if (!process.env.APPS_SCRIPT_URL) return null;

  try {
    const url = new URL(process.env.APPS_SCRIPT_URL);
    url.searchParams.set("action", action);
    Object.entries(parameters).forEach(([key, value]) => {
      if (value !== "" && value !== null && value !== undefined) url.searchParams.set(key, String(value));
    });
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) return { ok: false, error: `Apps Script ${response.status}` };
    const text = await response.text();
    return parseJsonText(text) || { ok: false, error: "Apps Script returned a non-JSON response" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function syncGuiPayload(payload) {
  if (standaloneStore) {
    try {
      return await standaloneStore.handleGuiPayload(payload);
    } catch (error) {
      return { ok: false, error: error.message, code: error.code || "database_sync_failed" };
    }
  }
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
  const pricing = require(path.join(root, "pricing.js"));
  return {
    categories: context.window.FRONTIER_CATEGORIES || [],
    items: context.window.FRONTIER_ITEMS || [],
    recipes: context.window.FRONTIER_RECIPES || {},
    recipeYields: context.window.FRONTIER_RECIPE_YIELDS || {},
    pricing
  };
}

function mergeCatalogWithSheetProducts(data, sheetSnapshot) {
  const sheetProducts = Array.isArray(sheetSnapshot?.inventory?.products)
    ? sheetSnapshot.inventory.products
    : [];
  const sheetMaterials = Array.isArray(sheetSnapshot?.inventory?.materials)
    ? sheetSnapshot.inventory.materials
    : [];
  const sheetRecipes = Array.isArray(sheetSnapshot?.recipes) ? sheetSnapshot.recipes : [];
  if (!sheetProducts.length && !sheetMaterials.length && !sheetRecipes.length) return data;

  const items = data.items.map(item => ({ ...item }));
  const materials = data.materials.map(material => ({ ...material }));
  const pricing = {
    ...data.pricing,
    products: { ...(data.pricing?.products || {}) },
    materials: { ...(data.pricing?.materials || {}) }
  };
  const lookup = new Map();
  items.forEach((item, index) => {
    [item.name, item.label, item.tag, ...(Array.isArray(item.aliases) ? item.aliases : [])].forEach(value => {
      const key = inventoryKey(value);
      if (key && !lookup.has(key)) lookup.set(key, index);
    });
  });
  const categories = new Set(data.categories);

  sheetProducts.forEach(product => {
    if (product.active === false) return;
    const name = String(product.itemName || "").trim();
    if (!name) return;
    const label = String(product.itemLabel || name).trim() || name;
    const tag = String(product.itemTag || "").trim();
    const category = String(product.category || "Resale").trim() || "Resale";
    const keys = [name, label, tag].map(inventoryKey).filter(Boolean);
    const index = keys.map(key => lookup.get(key)).find(value => value !== undefined);
    const base = index === undefined ? {} : items[index];
    const merged = {
      ...base,
      name,
      label,
      tag,
      id: product.id || base.id || "",
      itemType: product.itemType || "product",
      category,
      unit: String(product.unitName || base.unit || "unit"),
      unitCost: Number(product.unitCost || base.unitCost || 0),
      price: Number(product.salePrice || 0),
      resellerPrice: Number(product.resellerPrice ?? base.resellerPrice ?? 0),
      target: Number(product.target || 0),
      active: product.active !== false,
      aliases: Array.isArray(product.aliases) ? [...product.aliases] : base.aliases || [],
      msrpLow: product.msrpLow === null || product.msrpLow === undefined
        ? null
        : Number(product.msrpLow),
      msrpHigh: product.msrpHigh === null || product.msrpHigh === undefined
        ? null
        : Number(product.msrpHigh),
      pricingSource: String(product.pricingSource || "")
    };
    const mergedIndex = index === undefined ? items.push(merged) - 1 : index;
    if (index !== undefined) items[index] = merged;
    [merged.name, merged.label, merged.tag, ...(Array.isArray(merged.aliases) ? merged.aliases : [])]
      .forEach(value => {
        const key = inventoryKey(value);
        if (key) lookup.set(key, mergedIndex);
      });
    categories.add(category);
    pricing.products[name] = catalogPrice(Number(product.salePrice || 0), product.pricingSource || "Store Catalog");
  });

  const materialLookup = new Map();
  materials.forEach((material, index) => {
    [material.name, material.label, material.tag, ...(Array.isArray(material.aliases) ? material.aliases : [])]
      .forEach(value => {
        const key = inventoryKey(value);
        if (key && !materialLookup.has(key)) materialLookup.set(key, index);
      });
  });
  sheetMaterials.forEach(material => {
    if (material.active === false) return;
    const name = String(material.name || material.ingredient || "").trim();
    if (!name) return;
    const label = String(material.label || name).trim() || name;
    const tag = String(material.itemTag || "").trim();
    const category = String(material.category || "Materials").trim() || "Materials";
    const keys = [name, label, tag].map(inventoryKey).filter(Boolean);
    const index = keys.map(key => materialLookup.get(key)).find(value => value !== undefined);
    const base = index === undefined ? {} : materials[index];
    const unitCost = Number(material.unitCost ?? material.price ?? 0);
    const merged = {
      ...base,
      name,
      label,
      tag,
      id: material.id || base.id || "",
      itemType: material.itemType || "material",
      category,
      unit: String(material.unit || material.unitName || "unit"),
      price: unitCost,
      active: material.active !== false,
      aliases: Array.isArray(material.aliases) ? [...material.aliases] : base.aliases || []
    };
    const mergedIndex = index === undefined ? materials.push(merged) - 1 : index;
    if (index !== undefined) materials[index] = merged;
    [merged.name, merged.label, merged.tag, ...(Array.isArray(merged.aliases) ? merged.aliases : [])]
      .forEach(value => {
        const key = inventoryKey(value);
        if (key) materialLookup.set(key, mergedIndex);
      });
    categories.add(category);
    pricing.materials[name] = catalogPrice(unitCost, "Store Catalog");
  });

  const recipes = sheetRecipes.length ? {} : { ...(data.recipes || {}) };
  const recipeYields = sheetRecipes.length ? {} : { ...(data.recipeYields || {}) };
  sheetRecipes.forEach(recipe => {
    const productName = String(recipe.productName || "").trim();
    if (!productName) return;
    recipes[productName] = (Array.isArray(recipe.ingredients) ? recipe.ingredients : []).map(ingredient => [
      String(ingredient.name || ingredient.ingredient || "").trim(),
      Number(ingredient.quantity || 0),
      normalizeProductionSource(ingredient.sourceLocation)
    ]).filter(([ingredient, quantity]) => ingredient && quantity > 0);
    recipeYields[productName] = Math.max(1, Number(recipe.yield || 1));
  });

  return {
    ...data,
    categories: [...categories],
    items,
    materials,
    recipes,
    recipeYields,
    pricing
  };
}

function catalogPrice(value, source) {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  return { low: amount, high: amount, midpoint: amount, source: String(source || "Store Catalog") };
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

module.exports = { server, startServer, database, tenantManager };
