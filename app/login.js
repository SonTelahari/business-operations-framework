const loginForm = document.querySelector("#loginForm");
const registerForm = document.querySelector("#registerForm");
const loginTab = document.querySelector("#showLoginButton");
const registerTab = document.querySelector("#showRegisterButton");
const message = document.querySelector("#authMessage");
const workspaceInput = document.querySelector("#workspaceCodeInput");
const discordLoginButton = document.querySelector("#discordLoginButton");
const passwordLoginDivider = document.querySelector("#passwordLoginDivider");
const WORKSPACE_KEY = "business_ledger_workspace_code";
let configTimer = null;

loginTab.addEventListener("click", () => showMode("login"));
registerTab.addEventListener("click", () => showMode("register"));
loginForm.addEventListener("submit", login);
registerForm.addEventListener("submit", register);
workspaceInput.addEventListener("input", () => {
  workspaceInput.value = formatWorkspaceCode(workspaceInput.value);
  clearTimeout(configTimer);
  configTimer = setTimeout(loadPublicConfig, 250);
});

workspaceInput.value = formatWorkspaceCode(new URLSearchParams(window.location.search).get("workspace") || localStorage.getItem(WORKSPACE_KEY) || "");
loadPublicConfig();
loadDiscordLogin();
checkSession();

const discordError = new URLSearchParams(window.location.search).get("discord_error");
if (discordError) setMessage(discordError, "error");

async function loadDiscordLogin() {
  try {
    const response = await fetch("/api/discord-auth/status", { headers: { accept: "application/json" } });
    const result = await response.json();
    discordLoginButton.classList.toggle("hidden", !result.enabled);
    passwordLoginDivider.classList.toggle("hidden", !result.enabled);
  } catch {}
}

async function loadPublicConfig() {
  try {
    const code = formatWorkspaceCode(workspaceInput.value);
    const response = await fetch(`/api/public/config${code ? `?workspace=${encodeURIComponent(code)}` : ""}`, { headers: { accept: "application/json" } });
    const result = await response.json();
    if (!result.configured) {
      if (!result.hostedMode) window.location.replace("/setup.html");
      else resetBusinessIdentity(code ? "Workspace not found" : "Business Ledger");
      return;
    }
    if (result.workspace?.code) {
      workspaceInput.value = result.workspace.code;
      localStorage.setItem(WORKSPACE_KEY, result.workspace.code);
    }
    const business = result.business || {};
    const name = business.name || "Business";
    const ledgerName = business.ledgerName || `${name} Ledger`;
    document.title = `Sign In - ${name}`;
    document.querySelector("#loginLedgerName").textContent = ledgerName;
    document.querySelector("#loginBrand").setAttribute("aria-label", name);
    const location = document.querySelector("#loginBusinessLocation");
    const description = document.querySelector("#loginBusinessDescription");
    location.textContent = business.location || "";
    location.classList.toggle("hidden", !business.location);
    description.textContent = business.description || "";
    description.classList.toggle("hidden", !business.description);
    const logo = document.querySelector("#loginBusinessLogo");
    const monogram = document.querySelector("#loginBusinessMonogram");
    if (business.logoUrl) {
      logo.onerror = () => {
        logo.classList.add("hidden");
        monogram.classList.remove("hidden");
        monogram.textContent = initials(name);
      };
      logo.src = business.logoUrl;
      logo.alt = `${name} logo`;
      logo.classList.remove("hidden");
      monogram.classList.add("hidden");
    } else {
      logo.onerror = null;
      logo.classList.add("hidden");
      monogram.classList.remove("hidden");
      monogram.textContent = initials(name);
    }
  } catch {}
}

function resetBusinessIdentity(title) {
  document.title = "Sign In - Business Ledger";
  document.querySelector("#loginLedgerName").textContent = title;
  document.querySelector("#loginBusinessLogo").classList.add("hidden");
  document.querySelector("#loginBusinessMonogram").classList.remove("hidden");
  document.querySelector("#loginBusinessMonogram").textContent = "BL";
  document.querySelector("#loginBusinessLocation").classList.add("hidden");
  document.querySelector("#loginBusinessDescription").classList.add("hidden");
}

function formatWorkspaceCode(value) {
  const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  return compact.length > 5 ? `${compact.slice(0, 5)}-${compact.slice(5)}` : compact;
}

function initials(value) {
  return String(value || "Business Ledger").split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase();
}

async function checkSession() {
  try {
    const response = await fetch("/api/auth/session", { headers: { accept: "application/json" } });
    const result = await response.json();
    if (result.user) window.location.replace("/");
    else if (result.profileRequired || result.identity) window.location.replace("/profile.html");
  } catch {}
}

function showMode(mode) {
  const isLogin = mode === "login";
  loginForm.classList.toggle("hidden", !isLogin);
  registerForm.classList.toggle("hidden", isLogin);
  loginTab.classList.toggle("active", isLogin);
  registerTab.classList.toggle("active", !isLogin);
  loginTab.setAttribute("aria-selected", String(isLogin));
  registerTab.setAttribute("aria-selected", String(!isLogin));
  setMessage("");
  (isLogin ? document.querySelector("#loginNameInput") : document.querySelector("#registerNameInput")).focus();
}

async function login(event) {
  event.preventDefault();
  setBusy(loginForm, true);
  setMessage("");
  const result = await request("/api/auth/login", {
    workspaceCode: workspaceInput.value,
    fullName: document.querySelector("#loginNameInput").value,
    password: document.querySelector("#loginPasswordInput").value
  });
  setBusy(loginForm, false);
  if (result.ok) {
    localStorage.setItem(WORKSPACE_KEY, formatWorkspaceCode(workspaceInput.value));
    window.location.replace("/");
    return;
  }
  setMessage(result.error || "Unable to sign in", "error");
}

async function register(event) {
  event.preventDefault();
  const password = document.querySelector("#registerPasswordInput").value;
  if (password !== document.querySelector("#registerConfirmInput").value) {
    setMessage("Passwords do not match", "error");
    return;
  }
  setBusy(registerForm, true);
  setMessage("");
  const result = await request("/api/auth/register", {
    workspaceCode: workspaceInput.value,
    fullName: document.querySelector("#registerNameInput").value,
    password
  });
  setBusy(registerForm, false);
  if (!result.ok) {
    setMessage(result.error || "Unable to request access", "error");
    return;
  }
  registerForm.reset();
  setMessage("Request sent. An admin must approve the account before you can sign in.", "success");
}

async function request(url, payload) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload)
    });
    return await response.json();
  } catch {
    return { ok: false, error: "The server could not be reached" };
  }
}

function setBusy(form, busy) {
  form.querySelectorAll("input, button").forEach(control => { control.disabled = busy; });
  workspaceInput.disabled = busy;
}

function setMessage(text, tone = "") {
  message.textContent = text;
  message.className = `auth-message${tone ? ` ${tone}` : ""}`;
}
