(() => {
  if (!("serviceWorker" in navigator)) return;

  let installPrompt = null;
  let registration = null;
  let reloading = false;

  const controls = document.createElement("aside");
  controls.className = "pwa-controls hidden";
  controls.setAttribute("aria-label", "Application controls");

  const installButton = document.createElement("button");
  installButton.className = "secondary-button hidden";
  installButton.type = "button";
  installButton.textContent = "Install App";

  const updateButton = document.createElement("button");
  updateButton.className = "primary-button hidden";
  updateButton.type = "button";
  updateButton.textContent = "Update App";

  controls.append(installButton, updateButton);
  document.body.append(controls);

  function refreshControls() {
    const visible = !installButton.classList.contains("hidden")
      || !updateButton.classList.contains("hidden");
    controls.classList.toggle("hidden", !visible);
  }

  function showUpdate() {
    updateButton.classList.remove("hidden");
    refreshControls();
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
    installButton.classList.remove("hidden");
    refreshControls();
  });

  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    installButton.classList.add("hidden");
    refreshControls();
  });

  installButton.addEventListener("click", async () => {
    if (!installPrompt) return;
    installButton.disabled = true;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    installButton.disabled = false;
    if (choice.outcome === "accepted") {
      installPrompt = null;
      installButton.classList.add("hidden");
      refreshControls();
    }
  });

  updateButton.addEventListener("click", () => {
    updateButton.disabled = true;
    registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener("load", async () => {
    try {
      registration = await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
      if (registration.waiting) showUpdate();
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdate();
        });
      });
      window.setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000);
    } catch (error) {
      console.warn("App installation is unavailable:", error.message);
    }
  });
})();
