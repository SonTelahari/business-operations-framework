const { createInventoryPublisher } = require('./inventory-publisher');

const DEFAULT_DIRECTORY_REFRESH_MS = 60 * 1000;

function createSharedInventoryPublisher(options) {
  const client = options.client;
  const apiBaseUrl = String(options.apiBaseUrl || '').trim().replace(/\/+$/, '');
  const apiToken = String(options.apiToken || '').trim();
  const fetchImpl = options.fetchImpl || fetch;
  const publisherFactory = options.publisherFactory || createInventoryPublisher;
  const logger = options.logger || console;
  const refreshMs = Math.max(30000, numberOrZero(options.refreshMs) || 5 * 60 * 1000);
  const directoryRefreshMs = Math.max(
    30000,
    numberOrZero(options.directoryRefreshMs) || DEFAULT_DIRECTORY_REFRESH_MS
  );
  const requestHeaders = apiToken ? { authorization: `Bearer ${apiToken}` } : {};
  const enabled = Boolean(client && apiBaseUrl && apiToken);
  const publishers = new Map();
  const state = {
    started: false,
    lastDirectoryAttemptAt: '',
    lastDirectorySuccessAt: '',
    lastDirectoryError: ''
  };
  let directoryInterval = null;
  let directoryPromise = null;

  async function start() {
    if (!enabled || state.started) return;
    state.started = true;
    try {
      await refreshDirectory('startup');
    } catch {}
    directoryInterval = setInterval(() => {
      refreshDirectory('interval').catch(() => {});
    }, directoryRefreshMs);
    if (typeof directoryInterval.unref === 'function') directoryInterval.unref();
  }

  function stop() {
    state.started = false;
    if (directoryInterval) clearInterval(directoryInterval);
    directoryInterval = null;
    for (const entry of publishers.values()) entry.publisher.stop();
    publishers.clear();
  }

  async function refreshDirectory(reason = 'manual') {
    if (!enabled) return [];
    if (directoryPromise) return directoryPromise;
    state.lastDirectoryAttemptAt = new Date().toISOString();
    directoryPromise = runDirectoryRefresh(reason);
    try {
      return await directoryPromise;
    } finally {
      directoryPromise = null;
    }
  }

  async function runDirectoryRefresh(reason) {
    try {
      const integrations = await fetchDiscordIntegrationDirectory(
        `${apiBaseUrl}/api/integrations/discord/channels`,
        fetchImpl,
        requestHeaders
      );
      await reconcilePublishers(integrations);
      state.lastDirectorySuccessAt = new Date().toISOString();
      state.lastDirectoryError = '';
      logger.info(
        `Discord publisher directory refreshed (${reason}): ${publishers.size} active businesses`
      );
      return integrations;
    } catch (error) {
      state.lastDirectoryError = error.message;
      logger.error(`Discord publisher directory refresh failed (${reason}): ${error.message}`);
      throw error;
    }
  }

  async function reconcilePublishers(integrations) {
    const desired = new Map(integrations.map(integration => [integration.key, integration]));

    for (const [key, entry] of publishers) {
      const integration = desired.get(key);
      if (!integration || integration.signature !== entry.signature) {
        entry.publisher.stop();
        publishers.delete(key);
      }
    }

    for (const [key, integration] of desired) {
      if (publishers.has(key)) continue;
      const snapshotUrl = new URL(`${apiBaseUrl}/api/integrations/discord/snapshot`);
      snapshotUrl.searchParams.set('discord_channel_id', integration.eventChannelId);
      const publisher = publisherFactory({
        client,
        snapshotUrl: snapshotUrl.toString(),
        requestHeaders,
        inventoryChannelId: integration.inventoryChannelId,
        alertChannelId: integration.alertChannelId,
        refreshMs,
        fetchImpl,
        logger
      });
      publishers.set(key, { integration, publisher, signature: integration.signature });
      if (state.started) {
        await publisher.start();
      }
    }
  }

  function requestRefresh(reason = 'storefront event', eventChannelId = '') {
    const normalizedChannelId = String(eventChannelId || '').trim();
    for (const entry of publishers.values()) {
      if (normalizedChannelId && entry.integration.eventChannelId !== normalizedChannelId) continue;
      entry.publisher.requestRefresh(reason);
    }
  }

  async function handleInteraction(interaction) {
    for (const entry of publishers.values()) {
      if (await entry.publisher.handleInteraction(interaction)) return true;
    }
    return false;
  }

  function health() {
    const childHealth = [...publishers.values()].map(entry => entry.publisher.health());
    return {
      enabled,
      mode: 'shared',
      integration_count: publishers.size,
      inventory_channel_count: childHealth.filter(item => item.inventory_channel_configured).length,
      alert_channel_count: childHealth.filter(item => item.alert_channel_configured).length,
      product_count: childHealth.reduce((total, item) => total + numberOrZero(item.product_count), 0),
      shortage_count: childHealth.reduce((total, item) => total + numberOrZero(item.shortage_count), 0),
      refresh_seconds: Math.round(refreshMs / 1000),
      directory_refresh_seconds: Math.round(directoryRefreshMs / 1000),
      last_directory_attempt_at: state.lastDirectoryAttemptAt,
      last_directory_success_at: state.lastDirectorySuccessAt,
      last_directory_error: state.lastDirectoryError,
      publisher_error_count: childHealth.filter(item => item.last_error).length
    };
  }

  return {
    enabled,
    start,
    stop,
    refreshDirectory,
    requestRefresh,
    handleInteraction,
    health
  };
}

async function fetchDiscordIntegrationDirectory(directoryUrl, fetchImpl = fetch, requestHeaders = {}) {
  const response = await fetchImpl(new URL(directoryUrl), {
    headers: { accept: 'application/json', ...requestHeaders },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Business integration directory request failed (${response.status})`);
  const payload = await response.json();
  if (!payload?.ok || !Array.isArray(payload.integrations)) {
    throw new Error(payload?.error || 'Business API did not return Discord integrations');
  }
  return normalizeDiscordIntegrations(payload.integrations);
}

function normalizeDiscordIntegrations(integrations) {
  return integrations
    .map(integration => {
      const businessId = String(integration.businessId || '').trim();
      const workspaceCode = String(integration.workspaceCode || '').trim();
      const eventChannelId = String(integration.eventChannelId || '').trim();
      const inventoryChannelId = String(integration.inventoryChannelId || '').trim();
      const alertChannelId = String(integration.alertChannelId || '').trim();
      const status = String(integration.status || 'active').trim().toLowerCase();
      const key = businessId || workspaceCode || eventChannelId;
      return {
        key,
        businessId,
        workspaceCode,
        eventChannelId,
        inventoryChannelId,
        alertChannelId,
        status,
        signature: [eventChannelId, inventoryChannelId, alertChannelId].join('|')
      };
    })
    .filter(integration => integration.key
      && integration.status === 'active'
      && integration.eventChannelId
      && (integration.inventoryChannelId || integration.alertChannelId));
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

module.exports = {
  createSharedInventoryPublisher,
  fetchDiscordIntegrationDirectory,
  normalizeDiscordIntegrations
};
