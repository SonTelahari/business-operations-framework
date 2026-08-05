const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
const serviceWorker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const setupScript = fs.readFileSync(path.join(root, "setup.js"), "utf8");
const appHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");

assert.equal(manifest.name, "Business Operations Ledger");
assert.equal(manifest.display, "standalone");
assert.equal(manifest.scope, "/");
assert(manifest.icons.some(icon => icon.sizes === "192x192"));
assert(manifest.icons.some(icon => icon.sizes === "512x512"));
assert(manifest.icons.some(icon => icon.purpose === "maskable"));

for (const privateRoute of ['startsWith("/api/")', 'startsWith("/auth/")', 'startsWith("/health")']) {
  assert(serviceWorker.includes(privateRoute), `service worker must exclude ${privateRoute}`);
}
assert(serviceWorker.includes('request.mode === "navigate"'));
assert(!serviceWorker.includes("/index.html"), "authenticated HTML must not be pre-cached");
assert(server.includes('"Service-Worker-Allowed"'));
assert(server.includes('pathname === "/service-worker.js"'));

for (const htmlFile of ["index.html", "login.html", "profile.html", "setup.html"]) {
  const html = fs.readFileSync(path.join(root, htmlFile), "utf8");
  assert(html.includes('rel="manifest" href="/manifest.webmanifest"'), `${htmlFile} must link the manifest`);
  assert(html.includes('src="/pwa.js"'), `${htmlFile} must load the PWA controller`);
}

assert(setupScript.includes('select data-field="productName" required'), "recipe outputs must use a catalog dropdown");
assert(setupScript.includes('select data-field="ingredientName" required'), "recipe ingredients must use catalog dropdowns");
assert(setupScript.includes("data-add-ingredient-row"), "recipe cards must support additional ingredient rows");
assert(setupScript.includes("collectRecipeIngredients"), "recipe dropdown rows must serialize as structured ingredients");
assert(!setupScript.includes("parseIngredients("), "first-launch recipes must not require free-form ingredient parsing");
assert(appHtml.includes('id="openCatalogItemDialogButton"'), "the Store tab must expose manager catalog creation");
assert(appHtml.includes('id="catalogItemTypeInput"'), "manual catalog creation must distinguish products and materials");
assert(appHtml.includes('<option value="both">Product and material</option>'), "manual catalog creation must support dual-purpose goods");
assert(appHtml.includes('id="reviewItemTypeInput"'), "webhook review must create either product or material goods");
assert(appHtml.includes('data-section="business-settings"'), "administrators must have a business settings tab");
assert(appHtml.includes('id="businessSettingsForm"'), "business settings must expose a profile editor");
assert(appHtml.includes('id="settingsLogoPreview"'), "business settings must preview branding changes");
const loginHtml = fs.readFileSync(path.join(root, "login.html"), "utf8");
assert(loginHtml.includes('id="loginBusinessDescription"'), "the sign-in cover must display the configured business description");

function pngSize(fileName) {
  const data = fs.readFileSync(path.join(root, "assets", fileName));
  assert.equal(data.toString("ascii", 1, 4), "PNG");
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

assert.deepEqual(pngSize("operations-ledger-192.png"), [192, 192]);
assert.deepEqual(pngSize("operations-ledger-512.png"), [512, 512]);
assert.deepEqual(pngSize("operations-ledger-maskable-512.png"), [512, 512]);

console.log("PWA tests passed");
