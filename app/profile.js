const profileState = { identity: null, characters: [], memberships: [] };
const elements = {
  avatar: document.querySelector("#profileAvatar"),
  avatarFallback: document.querySelector("#profileAvatarFallback"),
  identityName: document.querySelector("#profileIdentityName"),
  username: document.querySelector("#profileUsername"),
  message: document.querySelector("#profileMessage"),
  characterForm: document.querySelector("#characterForm"),
  characterName: document.querySelector("#characterNameInput"),
  characterSetting: document.querySelector("#characterSettingInput"),
  characterList: document.querySelector("#characterList"),
  membershipForm: document.querySelector("#membershipForm"),
  membershipCharacter: document.querySelector("#membershipCharacterInput"),
  membershipWorkspace: document.querySelector("#membershipWorkspaceInput"),
  membershipList: document.querySelector("#membershipList"),
  linkForm: document.querySelector("#linkAccountForm"),
  linkCharacter: document.querySelector("#linkCharacterInput"),
  linkWorkspace: document.querySelector("#linkWorkspaceInput"),
  linkName: document.querySelector("#linkNameInput"),
  linkPassword: document.querySelector("#linkPasswordInput"),
  logout: document.querySelector("#profileLogoutButton")
};

elements.characterForm.addEventListener("submit", createCharacter);
elements.membershipForm.addEventListener("submit", requestMembership);
elements.linkForm.addEventListener("submit", linkAccount);
elements.logout.addEventListener("click", logout);
[elements.membershipWorkspace, elements.linkWorkspace].forEach(input => {
  input.addEventListener("input", () => { input.value = formatWorkspaceCode(input.value); });
});
elements.characterList.addEventListener("click", handleCharacterAction);
elements.membershipList.addEventListener("click", handleMembershipAction);

loadProfile();

async function loadProfile() {
  const result = await api("/api/profile");
  if (!result.ok) {
    window.location.replace("/login.html");
    return;
  }
  profileState.identity = result.identity;
  profileState.characters = result.characters || [];
  profileState.memberships = result.memberships || [];
  renderProfile();
}

function renderProfile() {
  const identity = profileState.identity || {};
  elements.identityName.textContent = identity.globalName || identity.username || "Discord Account";
  elements.username.textContent = identity.username ? `@${identity.username}` : "";
  elements.avatarFallback.textContent = initials(identity.globalName || identity.username || "D");
  if (identity.avatarUrl) {
    elements.avatar.src = identity.avatarUrl;
    elements.avatar.alt = `${identity.globalName || identity.username} avatar`;
    elements.avatar.classList.remove("hidden");
    elements.avatarFallback.classList.add("hidden");
  }
  renderCharacters();
  renderMemberships();
  renderCharacterOptions();
}

function renderCharacters() {
  const active = profileState.characters.filter(character => character.status === "active");
  elements.characterList.innerHTML = active.length ? active.map(character => `
    <article class="profile-row">
      <div>
        <strong>${escapeHtml(character.name)}</strong>
        <span>${escapeHtml(character.settingName || "No setting recorded")}</span>
      </div>
      <div class="profile-row-actions">
        <button class="ghost-button" type="button" data-character-edit="${character.id}">Edit</button>
        <button class="danger-button" type="button" data-character-archive="${character.id}">Archive</button>
      </div>
    </article>
  `).join("") : '<p class="profile-empty">No characters recorded</p>';
}

function renderMemberships() {
  elements.membershipList.innerHTML = profileState.memberships.length ? profileState.memberships.map(membership => `
    <article class="profile-row membership-row" data-status="${escapeHtml(membership.status)}">
      <div>
        <strong>${escapeHtml(membership.businessName)}</strong>
        <span>${escapeHtml(membership.characterName)} / ${roleLabel(membership.role)} / ${statusLabel(membership.status)}</span>
        <small>Workspace ${escapeHtml(membership.workspaceCode)}</small>
      </div>
      ${membership.status === "active"
        ? `<button class="primary-button" type="button" data-membership-open="${membership.id}" data-business-id="${membership.businessId}">Open Ledger</button>`
        : ""}
    </article>
  `).join("") : '<p class="profile-empty">No business memberships yet</p>';
}

function renderCharacterOptions() {
  const active = profileState.characters.filter(character => character.status === "active");
  const markup = active.length
    ? active.map(character => `<option value="${character.id}">${escapeHtml(character.name)}</option>`).join("")
    : '<option value="">Add a character first</option>';
  elements.membershipCharacter.innerHTML = markup;
  elements.linkCharacter.innerHTML = markup;
  elements.membershipForm.querySelector("button").disabled = !active.length;
  elements.linkForm.querySelector("button").disabled = !active.length;
}

async function createCharacter(event) {
  event.preventDefault();
  setFormBusy(elements.characterForm, true);
  const result = await api("/api/profile/characters", {
    method: "POST",
    body: { name: elements.characterName.value, settingName: elements.characterSetting.value }
  });
  setFormBusy(elements.characterForm, false);
  if (!result.ok) return setMessage(result.error || "Character could not be added", "error");
  elements.characterForm.reset();
  setMessage("Character added", "success");
  await loadProfile();
}

async function requestMembership(event) {
  event.preventDefault();
  setFormBusy(elements.membershipForm, true);
  const result = await api("/api/profile/memberships", {
    method: "POST",
    body: {
      characterId: elements.membershipCharacter.value,
      workspaceCode: elements.membershipWorkspace.value
    }
  });
  setFormBusy(elements.membershipForm, false);
  if (!result.ok) return setMessage(result.error || "Access request could not be sent", "error");
  elements.membershipWorkspace.value = "";
  setMessage("Access request sent for manager approval", "success");
  await loadProfile();
}

async function linkAccount(event) {
  event.preventDefault();
  setFormBusy(elements.linkForm, true);
  const result = await api("/api/profile/link-local", {
    method: "POST",
    body: {
      characterId: elements.linkCharacter.value,
      workspaceCode: elements.linkWorkspace.value,
      fullName: elements.linkName.value,
      password: elements.linkPassword.value
    }
  });
  setFormBusy(elements.linkForm, false);
  if (!result.ok) return setMessage(result.error || "Account could not be linked", "error");
  elements.linkForm.reset();
  setMessage("Existing account linked to your Discord profile", "success");
  await loadProfile();
}

async function handleCharacterAction(event) {
  const edit = event.target.closest("[data-character-edit]");
  const archive = event.target.closest("[data-character-archive]");
  if (!edit && !archive) return;
  const id = edit?.dataset.characterEdit || archive.dataset.characterArchive;
  const character = profileState.characters.find(entry => entry.id === id);
  if (!character) return;
  if (edit) {
    const name = window.prompt("Character name", character.name);
    if (!name) return;
    const settingName = window.prompt("Server or setting", character.settingName || "");
    if (settingName === null) return;
    const result = await api(`/api/profile/characters/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { name, settingName }
    });
    if (!result.ok) return setMessage(result.error || "Character could not be updated", "error");
  } else {
    if (!window.confirm(`Archive ${character.name}?`)) return;
    const result = await api(`/api/profile/characters/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!result.ok) return setMessage(result.error || "Character could not be archived", "error");
  }
  await loadProfile();
}

async function handleMembershipAction(event) {
  const button = event.target.closest("[data-membership-open]");
  if (!button) return;
  button.disabled = true;
  const result = await api("/api/profile/select", {
    method: "POST",
    body: { membershipId: button.dataset.membershipOpen, businessId: button.dataset.businessId }
  });
  if (!result.ok) {
    button.disabled = false;
    return setMessage(result.error || "Business could not be opened", "error");
  }
  localStorage.setItem("business_ledger_workspace_code", result.workspace?.code || "");
  window.location.replace("/");
}

async function logout() {
  elements.logout.disabled = true;
  await api("/api/profile/logout", { method: "POST" });
  window.location.replace("/login.html");
}

async function api(url, { method = "GET", body = null } = {}) {
  try {
    const response = await fetch(url, {
      method,
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const result = await response.json();
    return { ...result, status: response.status };
  } catch {
    return { ok: false, error: "The profile service could not be reached" };
  }
}

function setFormBusy(form, busy) {
  form.querySelectorAll("input, select, button").forEach(control => { control.disabled = busy; });
}

function setMessage(text, tone = "") {
  elements.message.textContent = text;
  elements.message.className = `profile-message${tone ? ` ${tone}` : ""}`;
}

function formatWorkspaceCode(value) {
  const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  return compact.length > 5 ? `${compact.slice(0, 5)}-${compact.slice(5)}` : compact;
}

function roleLabel(value) {
  return ({ admin: "Admin", manager: "Manager", employee: "Employee" })[value] || value;
}

function statusLabel(value) {
  return ({ pending: "Awaiting approval", active: "Active", disabled: "Disabled", rejected: "Rejected" })[value] || value;
}

function initials(value) {
  return String(value || "D").split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}
