const loginForm = document.querySelector("#loginForm");
const registerForm = document.querySelector("#registerForm");
const loginTab = document.querySelector("#showLoginButton");
const registerTab = document.querySelector("#showRegisterButton");
const message = document.querySelector("#authMessage");

loginTab.addEventListener("click", () => showMode("login"));
registerTab.addEventListener("click", () => showMode("register"));
loginForm.addEventListener("submit", login);
registerForm.addEventListener("submit", register);

checkSession();

async function checkSession() {
  try {
    const response = await fetch("/api/auth/session", { headers: { accept: "application/json" } });
    const result = await response.json();
    if (result.user) window.location.replace("/");
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
    fullName: document.querySelector("#loginNameInput").value,
    password: document.querySelector("#loginPasswordInput").value
  });
  setBusy(loginForm, false);
  if (result.ok) {
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
}

function setMessage(text, tone = "") {
  message.textContent = text;
  message.className = `auth-message${tone ? ` ${tone}` : ""}`;
}
