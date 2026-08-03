const DRAFT_KEY = "business_ledger_first_launch_draft_v1";
const STEP_COUNT = 5;

let activeStep = 0;
let highestVisitedStep = 0;
let saveTimer = null;

const elements = {
  form: document.querySelector("#setupForm"),
  progressText: document.querySelector("#setupProgressText"),
  message: document.querySelector("#setupMessage"),
  back: document.querySelector("#setupBackButton"),
  next: document.querySelector("#setupNextButton"),
  finish: document.querySelector("#setupFinishButton"),
  locations: document.querySelector("#locationRows"),
  materials: document.querySelector("#materialRows"),
  products: document.querySelector("#productRows"),
  recipes: document.querySelector("#recipeRows"),
  materialCount: document.querySelector("#materialCount"),
  productCount: document.querySelector("#productCount"),
  productOptions: document.querySelector("#setupProductOptions"),
  review: document.querySelector("#setupReview")
};

wireEvents();
initialize();

async function initialize() {
  try {
    const response = await fetch("/api/setup/status", { headers: { accept: "application/json" } });
    const status = await response.json();
    if (!status.setupRequired) {
      window.location.replace("/");
      return;
    }
    document.querySelector("#ownerSetupNote").textContent = status.ownerAccountExists
      ? "Enter the credentials of the pre-provisioned administrator account."
      : "This account receives administrator access.";
    const inviteRequired = Boolean(status.workspaceSignup?.inviteRequired);
    document.querySelector("#workspaceInviteField").classList.toggle("hidden", !inviteRequired);
    document.querySelector("#workspaceInviteInput").required = inviteRequired;
    document.querySelector("#discordSetupFields").classList.toggle("hidden", !status.hostedMode);
    restoreDraft(status.defaults || {});
    showStep(0);
  } catch {
    setMessage("The setup service could not be reached.", "error");
  }
}

function wireEvents() {
  elements.back.addEventListener("click", () => showStep(activeStep - 1));
  elements.next.addEventListener("click", () => {
    if (!validateStep(activeStep)) return;
    showStep(activeStep + 1);
  });
  elements.form.addEventListener("submit", completeSetup);
  document.querySelector("#addLocationButton").addEventListener("click", () => addLocationRow());
  document.querySelector("#addMaterialButton").addEventListener("click", () => addMaterialRow());
  document.querySelector("#addProductButton").addEventListener("click", () => addProductRow());
  document.querySelector("#addRecipeButton").addEventListener("click", () => addRecipeRow());
  document.querySelectorAll("[data-setup-nav]").forEach(button => {
    button.addEventListener("click", () => {
      const target = Number(button.dataset.setupNav);
      if (target <= highestVisitedStep && (target < activeStep || validateStep(activeStep))) showStep(target);
    });
  });
  elements.form.addEventListener("input", () => {
    updateDerivedViews();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 300);
  });
  elements.form.addEventListener("click", event => {
    const remove = event.target.closest("[data-remove-row]");
    if (!remove) return;
    remove.closest("[data-setup-row]")?.remove();
    updateDerivedViews();
    saveDraft();
  });
}

function showStep(step) {
  activeStep = Math.max(0, Math.min(STEP_COUNT - 1, step));
  highestVisitedStep = Math.max(highestVisitedStep, activeStep);
  document.querySelectorAll("[data-setup-step]").forEach(section => {
    section.classList.toggle("active", Number(section.dataset.setupStep) === activeStep);
  });
  document.querySelectorAll("[data-setup-nav]").forEach(button => {
    const index = Number(button.dataset.setupNav);
    button.classList.toggle("active", index === activeStep);
    button.classList.toggle("complete", index < activeStep);
    button.disabled = index > highestVisitedStep;
  });
  elements.progressText.textContent = `Page ${activeStep + 1} of ${STEP_COUNT}`;
  elements.back.disabled = activeStep === 0;
  elements.next.classList.toggle("hidden", activeStep === STEP_COUNT - 1);
  elements.finish.classList.toggle("hidden", activeStep !== STEP_COUNT - 1);
  if (activeStep === STEP_COUNT - 1) renderReview();
  setMessage("");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function validateStep(step) {
  const section = document.querySelector(`[data-setup-step="${step}"]`);
  const controls = [...section.querySelectorAll("input, select, textarea")].filter(control => !control.disabled);
  for (const control of controls) {
    if (!control.reportValidity()) return false;
  }
  if (step === 1) {
    const password = document.querySelector("#ownerPasswordInput").value;
    if (password !== document.querySelector("#ownerConfirmInput").value) {
      setMessage("Owner passwords do not match.", "error");
      return false;
    }
  }
  if (step === 2) {
    const types = collectRows(elements.locations).map(row => row.querySelector("[data-field='type']").value);
    if (!types.includes("sales") || !types.includes("storage")) {
      setMessage("Keep at least one sales location and one storage location.", "error");
      return false;
    }
  }
  return true;
}

async function completeSetup(event) {
  event.preventDefault();
  if (!validateStep(activeStep)) return;
  setBusy(true);
  setMessage("Opening the ledger...");
  try {
    const payload = collectPayload();
    const response = await fetch("/api/setup/complete", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "Setup could not be completed");
    localStorage.removeItem(DRAFT_KEY);
    if (result.workspace?.code) localStorage.setItem("business_ledger_workspace_code", result.workspace.code);
    window.location.replace("/");
  } catch (error) {
    setBusy(false);
    setMessage(error.message, "error");
  }
}

function collectPayload() {
  const materials = collectRows(elements.materials).map(row => ({
    name: value(row, "name"),
    category: value(row, "category"),
    unit: value(row, "unit"),
    unitCost: numberValue(row, "unitCost")
  }));
  const products = collectRows(elements.products).map(row => ({
    name: value(row, "name"),
    label: value(row, "label"),
    tag: value(row, "tag"),
    category: value(row, "category"),
    salePrice: numberValue(row, "salePrice"),
    target: numberValue(row, "target"),
    active: true
  }));
  return {
    inviteCode: document.querySelector("#workspaceInviteInput").value,
    discordIntegration: {
      guildId: document.querySelector("#discordGuildIdInput").value.trim(),
      eventChannelId: document.querySelector("#discordEventChannelIdInput").value.trim(),
      inventoryChannelId: document.querySelector("#discordInventoryChannelIdInput").value.trim(),
      alertChannelId: document.querySelector("#discordAlertChannelIdInput").value.trim()
    },
    owner: {
      fullName: document.querySelector("#ownerNameInput").value.trim(),
      password: document.querySelector("#ownerPasswordInput").value
    },
    configuration: {
      business: {
        name: document.querySelector("#businessNameInput").value.trim(),
        ledgerName: document.querySelector("#ledgerNameInput").value.trim(),
        location: document.querySelector("#businessLocationInput").value.trim(),
        referenceId: document.querySelector("#businessReferenceIdInput").value.trim(),
        logoUrl: document.querySelector("#logoUrlInput").value.trim(),
        currency: document.querySelector("#currencyInput").value.trim(),
        locale: document.querySelector("#localeInput").value.trim(),
        timezone: document.querySelector("#timezoneInput").value.trim(),
        description: document.querySelector("#businessDescriptionInput").value.trim()
      },
      terminology: {
        salesLocation: collectRows(elements.locations).find(row => value(row, "type") === "sales")?.querySelector("[data-field='name']").value || "Storefront",
        storageLocation: collectRows(elements.locations).find(row => value(row, "type") === "storage")?.querySelector("[data-field='name']").value || "Storage",
        salesOrder: "Sales Order"
      },
      locations: collectRows(elements.locations).map(row => ({
        name: value(row, "name"),
        type: value(row, "type")
      })),
      modules: Object.fromEntries([...document.querySelectorAll("input[name='module']")].map(input => [input.value, input.checked])),
      catalog: {
        materials,
        products,
        recipes: collectRows(elements.recipes).map(row => ({
          productName: value(row, "productName"),
          yield: numberValue(row, "yield") || 1,
          ingredients: parseIngredients(value(row, "ingredients"), value(row, "productName"))
        }))
      }
    }
  };
}

function parseIngredients(text, productName) {
  return String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    const match = line.match(/^(.+?)\s*(?:\||,)\s*([0-9]+(?:\.[0-9]+)?)$/);
    if (!match) throw new Error(`Recipe line ${index + 1} for ${productName || "product"} must use: Ingredient | quantity`);
    return { name: match[1].trim(), quantity: Number(match[2]) };
  });
}

function addLocationRow(location = {}) {
  removeEmpty(elements.locations);
  elements.locations.insertAdjacentHTML("beforeend", `
    <div class="setup-grid-row location-row" data-setup-row>
      <label>Name<input data-field="name" required maxlength="60" value="${escapeHtml(location.name || "")}"></label>
      <label>Type<select data-field="type">
        ${optionMarkup(["sales", "storage", "production", "other"], location.type || "other")}
      </select></label>
      <button class="remove-row-button" data-remove-row type="button" aria-label="Remove location">Remove</button>
    </div>
  `);
}

function addMaterialRow(material = {}) {
  removeEmpty(elements.materials);
  elements.materials.insertAdjacentHTML("beforeend", `
    <div class="setup-grid-row material-row" data-setup-row>
      <label>Name<input data-field="name" required maxlength="100" value="${escapeHtml(material.name || "")}"></label>
      <label>Category<input data-field="category" maxlength="60" value="${escapeHtml(material.category || "Materials")}"></label>
      <label>Unit<input data-field="unit" maxlength="30" value="${escapeHtml(material.unit || "unit")}"></label>
      <label>Unit cost<input data-field="unitCost" type="number" min="0" step="0.01" value="${numericValue(material.unitCost)}"></label>
      <button class="remove-row-button" data-remove-row type="button" aria-label="Remove material">Remove</button>
    </div>
  `);
  updateDerivedViews();
}

function addProductRow(product = {}) {
  removeEmpty(elements.products);
  elements.products.insertAdjacentHTML("beforeend", `
    <div class="setup-grid-row product-row" data-setup-row>
      <label>Internal name<input data-field="name" required maxlength="100" value="${escapeHtml(product.name || "")}"></label>
      <label>Display label<input data-field="label" maxlength="100" value="${escapeHtml(product.label || "")}"></label>
      <label>Category<input data-field="category" maxlength="60" value="${escapeHtml(product.category || "Products")}"></label>
      <label>Item tag<input data-field="tag" maxlength="150" value="${escapeHtml(product.tag || "")}"></label>
      <label>Sale price<input data-field="salePrice" type="number" min="0" step="0.01" value="${numericValue(product.salePrice)}"></label>
      <label>Stock target<input data-field="target" type="number" min="0" step="1" value="${numericValue(product.target)}"></label>
      <button class="remove-row-button" data-remove-row type="button" aria-label="Remove product">Remove</button>
    </div>
  `);
  updateDerivedViews();
}

function addRecipeRow(recipe = {}) {
  removeEmpty(elements.recipes);
  const ingredientText = recipe.ingredientText || (recipe.ingredients || []).map(item => `${item.name} | ${item.quantity}`).join("\n");
  elements.recipes.insertAdjacentHTML("beforeend", `
    <article class="setup-recipe-row" data-setup-row>
      <div class="recipe-row-heading">
        <label>Output<input data-field="productName" list="setupProductOptions" required value="${escapeHtml(recipe.productName || "")}"></label>
        <label>Output quantity<input data-field="yield" type="number" min="0.01" step="0.01" value="${numericValue(recipe.yield || 1)}"></label>
        <button class="remove-row-button" data-remove-row type="button" aria-label="Remove recipe">Remove</button>
      </div>
      <label>Ingredients
        <textarea data-field="ingredients" rows="5" required placeholder="Material | quantity">${escapeHtml(ingredientText)}</textarea>
      </label>
    </article>
  `);
}

function updateDerivedViews() {
  const materials = collectRows(elements.materials);
  const products = collectRows(elements.products);
  elements.materialCount.textContent = `${materials.length} ${materials.length === 1 ? "entry" : "entries"}`;
  elements.productCount.textContent = `${products.length} ${products.length === 1 ? "entry" : "entries"}`;
  elements.productOptions.innerHTML = [...materials, ...products]
    .map(row => `<option value="${escapeHtml(value(row, "name"))}"></option>`)
    .join("");
  ensureEmpty(elements.materials, "No materials entered");
  ensureEmpty(elements.products, "No products entered");
  ensureEmpty(elements.recipes, "No recipes entered");
  if (activeStep === STEP_COUNT - 1) renderReview();
}

function renderReview() {
  const business = document.querySelector("#businessNameInput").value.trim() || "Unnamed business";
  const locations = collectRows(elements.locations).length;
  const materials = collectRows(elements.materials).length;
  const products = collectRows(elements.products).length;
  const recipes = collectRows(elements.recipes).length;
  elements.review.innerHTML = `
    <h3>${escapeHtml(business)}</h3>
    <div>
      <span><strong>${locations}</strong> locations</span>
      <span><strong>${materials}</strong> materials</span>
      <span><strong>${products}</strong> products</span>
      <span><strong>${recipes}</strong> recipes</span>
    </div>
  `;
}

function saveDraft() {
  const draft = {
    fields: Object.fromEntries([...elements.form.querySelectorAll("input[id], textarea[id]")]
      .filter(control => control.type !== "password")
      .map(control => [control.id, control.value])),
    modules: Object.fromEntries([...document.querySelectorAll("input[name='module']")].map(input => [input.value, input.checked])),
    locations: collectRows(elements.locations).map(row => ({ name: value(row, "name"), type: value(row, "type") })),
    materials: collectRows(elements.materials).map(row => rowData(row, ["name", "category", "unit", "unitCost"])),
    products: collectRows(elements.products).map(row => rowData(row, ["name", "label", "category", "tag", "salePrice", "target"])),
    recipes: collectRows(elements.recipes).map(row => ({
      productName: value(row, "productName"),
      yield: value(row, "yield"),
      ingredientText: value(row, "ingredients")
    }))
  };
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

function restoreDraft(defaults) {
  const draft = parseJson(localStorage.getItem(DRAFT_KEY)) || {};
  const business = defaults.business || {};
  const initialFields = {
    businessNameInput: business.name || "",
    ledgerNameInput: business.ledgerName || "Business Ledger",
    businessLocationInput: business.location || "",
    businessReferenceIdInput: business.referenceId || "",
    logoUrlInput: business.logoUrl || "",
    currencyInput: business.currency || "USD",
    localeInput: navigator.language || business.locale || "en-US",
    timezoneInput: Intl.DateTimeFormat().resolvedOptions().timeZone || business.timezone || "UTC",
    businessDescriptionInput: business.description || "",
    ...(draft.fields || {})
  };
  Object.entries(initialFields).forEach(([id, value]) => {
    const control = document.getElementById(id);
    if (control) control.value = value;
  });
  const locations = draft.locations?.length ? draft.locations : (defaults.locations || []);
  locations.forEach(addLocationRow);
  (draft.materials || []).forEach(addMaterialRow);
  (draft.products || []).forEach(addProductRow);
  (draft.recipes || []).forEach(addRecipeRow);
  document.querySelectorAll("input[name='module']").forEach(input => {
    const configured = draft.modules?.[input.value];
    if (configured !== undefined) input.checked = configured;
    else if (defaults.modules?.[input.value] !== undefined) input.checked = defaults.modules[input.value];
  });
  updateDerivedViews();
}

function collectRows(container) {
  return [...container.querySelectorAll(":scope > [data-setup-row]")];
}

function value(row, field) {
  return row?.querySelector(`[data-field="${field}"]`)?.value.trim() || "";
}

function numberValue(row, field) {
  const text = value(row, field);
  return text === "" ? 0 : Number(text);
}

function rowData(row, fields) {
  return Object.fromEntries(fields.map(field => [field, value(row, field)]));
}

function ensureEmpty(container, text) {
  const empty = container.querySelector(".setup-empty");
  if (collectRows(container).length) empty?.remove();
  else if (!empty) container.insertAdjacentHTML("beforeend", `<p class="setup-empty">${escapeHtml(text)}</p>`);
}

function removeEmpty(container) {
  container.querySelector(".setup-empty")?.remove();
}

function optionMarkup(options, selected) {
  return options.map(option => `<option value="${option}"${option === selected ? " selected" : ""}>${option[0].toUpperCase()}${option.slice(1)}</option>`).join("");
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? String(number) : "0";
}

function setBusy(busy) {
  elements.form.querySelectorAll("input, select, textarea, button").forEach(control => { control.disabled = busy; });
}

function setMessage(text, tone = "") {
  elements.message.textContent = text;
  elements.message.className = `setup-message${tone ? ` ${tone}` : ""}`;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
