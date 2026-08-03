const elements = {
  loginPanel: document.querySelector("#operatorLoginPanel"),
  loginForm: document.querySelector("#operatorLoginForm"),
  secret: document.querySelector("#operatorSecretInput"),
  desk: document.querySelector("#operatorDesk"),
  logout: document.querySelector("#operatorLogoutButton"),
  inviteForm: document.querySelector("#operatorInviteForm"),
  inviteRows: document.querySelector("#operatorInviteRows"),
  workspaceRows: document.querySelector("#operatorWorkspaceRows"),
  auditRows: document.querySelector("#operatorAuditRows"),
  issued: document.querySelector("#operatorIssuedInvite"),
  issuedCode: document.querySelector("#operatorIssuedCode"),
  copyInvite: document.querySelector("#operatorCopyInviteButton"),
  refresh: document.querySelector("#operatorRefreshButton"),
  ownerResetDialog: document.querySelector("#operatorOwnerResetDialog"),
  ownerResetForm: document.querySelector("#operatorOwnerResetForm"),
  ownerResetBusiness: document.querySelector("#operatorOwnerResetBusiness"),
  ownerResetBusinessId: document.querySelector("#operatorOwnerResetBusinessId"),
  ownerResetPassword: document.querySelector("#operatorOwnerResetPassword"),
  ownerResetConfirm: document.querySelector("#operatorOwnerResetConfirm"),
  message: document.querySelector("#operatorMessage")
};

wireEvents();
initialize();

async function initialize() {
  try {
    const session = await api("/api/operator/session");
    if (!session.enabled) {
      setMessage("Set PLATFORM_ADMIN_SECRET to enable the service desk.", "error");
      elements.loginForm.querySelector("button").disabled = true;
      return;
    }
    showDesk(Boolean(session.authenticated));
    if (session.authenticated) await refreshOverview();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

function wireEvents() {
  elements.loginForm.addEventListener("submit", async event => {
    event.preventDefault();
    setMessage("Opening the service desk...");
    try {
      await api("/api/operator/login", { method: "POST", body: { secret: elements.secret.value } });
      elements.secret.value = "";
      showDesk(true);
      await refreshOverview();
    } catch (error) {
      setMessage(error.message, "error");
    }
  });
  elements.logout.addEventListener("click", async () => {
    await api("/api/operator/logout", { method: "POST", body: {} }).catch(() => {});
    showDesk(false);
  });
  elements.refresh.addEventListener("click", refreshOverview);
  elements.inviteForm.addEventListener("submit", createInvite);
  elements.copyInvite.addEventListener("click", async () => {
    await navigator.clipboard.writeText(elements.issuedCode.textContent);
    setMessage("Invitation code copied.", "success");
  });
  elements.inviteRows.addEventListener("click", async event => {
    const button = event.target.closest("[data-revoke-invite]");
    if (!button) return;
    if (!window.confirm("Revoke this invitation? Existing workspace data is not affected.")) return;
    await runAction(`/api/operator/invites/${encodeURIComponent(button.dataset.revokeInvite)}/revoke`, {});
  });
  elements.workspaceRows.addEventListener("click", async event => {
    const resetButton = event.target.closest("[data-reset-owner]");
    if (resetButton) {
      elements.ownerResetBusiness.textContent = resetButton.dataset.businessName;
      elements.ownerResetBusinessId.value = resetButton.dataset.resetOwner;
      elements.ownerResetPassword.value = "";
      elements.ownerResetConfirm.value = "";
      elements.ownerResetDialog.showModal();
      elements.ownerResetPassword.focus();
      return;
    }
    const statusButton = event.target.closest("[data-workspace-action]");
    if (!statusButton) return;
    const action = statusButton.dataset.workspaceAction;
    const businessId = statusButton.dataset.businessId;
    const message = action === "suspend"
      ? "Suspend access to this workspace? All data will remain stored."
      : "Reactivate this workspace?";
    if (!window.confirm(message)) return;
    await runAction(`/api/operator/workspaces/${encodeURIComponent(businessId)}/${action}`, {
      reason: action === "suspend" ? "Suspended from the beta service desk" : "Reactivated from the beta service desk"
    });
  });
  document.querySelector("#operatorOwnerResetCancel").addEventListener("click", () => elements.ownerResetDialog.close());
  elements.ownerResetForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (elements.ownerResetPassword.value !== elements.ownerResetConfirm.value) {
      setMessage("Temporary passwords do not match.", "error");
      return;
    }
    try {
      await api(`/api/operator/workspaces/${encodeURIComponent(elements.ownerResetBusinessId.value)}/reset-owner`, {
        method: "POST",
        body: { password: elements.ownerResetPassword.value }
      });
      elements.ownerResetDialog.close();
      elements.ownerResetForm.reset();
      setMessage("Owner password reset. Existing password sessions were invalidated.", "success");
      await refreshOverview(false);
    } catch (error) {
      setMessage(error.message, "error");
    }
  });
}

async function createInvite(event) {
  event.preventDefault();
  try {
    const result = await api("/api/operator/invites", {
      method: "POST",
      body: {
        label: document.querySelector("#inviteLabelInput").value,
        maxUses: Number(document.querySelector("#inviteUsesInput").value),
        expiresAt: expiryValue(document.querySelector("#inviteExpiryInput").value)
      }
    });
    elements.issuedCode.textContent = result.invite.code;
    elements.issued.classList.remove("hidden");
    elements.inviteForm.reset();
    document.querySelector("#inviteUsesInput").value = "1";
    setMessage("Invitation issued. This is the only time the full code is shown.", "success");
    await refreshOverview(false);
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function runAction(path, body) {
  try {
    await api(path, { method: "POST", body });
    await refreshOverview(false);
    setMessage("Service record updated.", "success");
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function refreshOverview(showProgress = true) {
  if (showProgress) setMessage("Reading the hosted ledgers...");
  try {
    const overview = await api("/api/operator/overview");
    renderInvites(overview.invites);
    renderWorkspaces(overview.workspaces);
    renderAudit(overview.audit);
    if (showProgress) setMessage(`Updated ${formatDateTime(overview.generatedAt)}.`, "success");
  } catch (error) {
    if (error.status === 401) showDesk(false);
    setMessage(error.message, "error");
  }
}

function renderInvites(invites) {
  elements.inviteRows.innerHTML = invites.length ? invites.map(invite => `
    <tr>
      <td>${escapeHtml(invite.label)}</td>
      <td><code>ends ${escapeHtml(invite.codeHint)}</code></td>
      <td>${invite.useCount} / ${invite.maxUses}</td>
      <td>${invite.expiresAt ? formatDate(invite.expiresAt) : "No expiry"}</td>
      <td><span class="operator-status ${escapeHtml(invite.status)}">${escapeHtml(invite.status)}</span></td>
      <td>${invite.status === "active" ? `<button class="secondary-button compact-button" type="button" data-revoke-invite="${escapeHtml(invite.id)}">Revoke</button>` : ""}</td>
    </tr>
  `).join("") : emptyRow(6, "No invitations issued yet.");
}

function renderWorkspaces(workspaces) {
  elements.workspaceRows.innerHTML = workspaces.length ? workspaces.map(workspace => {
    const action = workspace.status === "active" ? "suspend" : "reactivate";
    return `
      <tr>
        <td><strong>${escapeHtml(workspace.name)}</strong><small>${escapeHtml(workspace.referenceId || "No in-game ID")}</small></td>
        <td><code>${escapeHtml(workspace.code)}</code><small>${escapeHtml(workspace.id)}</small></td>
        <td>${workspace.catalogItems}<small>${workspace.activeDiscordMembers} Discord member${workspace.activeDiscordMembers === 1 ? "" : "s"}</small></td>
        <td>${formatDateTime(workspace.lastActivityAt)}</td>
        <td><span class="operator-status ${escapeHtml(workspace.status)}">${escapeHtml(workspace.status)}</span></td>
        <td class="operator-actions">
          <a class="secondary-button compact-button" href="/api/operator/workspaces/${encodeURIComponent(workspace.id)}/export">Export</a>
          <button class="secondary-button compact-button" type="button" data-reset-owner="${escapeHtml(workspace.id)}" data-business-name="${escapeHtml(workspace.name)}">Reset Owner</button>
          <button class="secondary-button compact-button" type="button" data-workspace-action="${action}" data-business-id="${escapeHtml(workspace.id)}">${capitalize(action)}</button>
        </td>
      </tr>
    `;
  }).join("") : emptyRow(6, "No beta workspaces have been created.");
}

function renderAudit(events) {
  elements.auditRows.innerHTML = events.length ? events.map(event => `
    <article>
      <time>${formatDateTime(event.occurredAt)}</time>
      <strong>${escapeHtml(event.action.replaceAll(".", " "))}</strong>
      <span>${escapeHtml(event.details.name || event.details.label || event.details.workspaceCode || event.actor)}</span>
    </article>
  `).join("") : "<p>No platform actions recorded yet.</p>";
}

function showDesk(authenticated) {
  elements.loginPanel.classList.toggle("hidden", authenticated);
  elements.desk.classList.toggle("hidden", !authenticated);
  elements.logout.classList.toggle("hidden", !authenticated);
  if (!authenticated) elements.issued.classList.add("hidden");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const result = await response.json().catch(() => ({ ok: false, error: "The service returned an unreadable response" }));
  if (!response.ok || result.ok === false) {
    const error = new Error(result.error || "The request could not be completed");
    error.status = response.status;
    throw error;
  }
  return result;
}

function expiryValue(value) {
  if (!value) return "";
  const date = new Date(`${value}T23:59:59.999Z`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function formatDate(value) {
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date) : "";
}

function formatDateTime(value) {
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", hour12: false }).format(date)
    : "No activity yet";
}

function emptyRow(columns, label) {
  return `<tr><td colspan="${columns}" class="operator-empty">${escapeHtml(label)}</td></tr>`;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function setMessage(message, state = "") {
  elements.message.textContent = message || "";
  elements.message.className = `form-message ${state}`.trim();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);
}
