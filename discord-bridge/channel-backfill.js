const DEFAULT_BACKFILL_LIMIT = 100;

function createRegisteredChannelBackfill(options = {}) {
  const client = options.client;
  const apiBaseUrl = String(options.apiBaseUrl || '').trim().replace(/\/+$/, '');
  const apiToken = String(options.apiToken || '').trim();
  const processMessage = options.processMessage;
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const limit = normalizeBackfillLimit(options.limit);
  const enabled = Boolean(client && apiBaseUrl && apiToken && processMessage && limit > 0);
  const state = {
    running: false,
    lastAttemptAt: '',
    lastSuccessAt: '',
    lastError: '',
    channelCount: 0,
    messageCount: 0,
    payloadCount: 0,
    duplicateCount: 0,
    appliedCount: 0,
    reviewCount: 0,
    errorCount: 0
  };
  let runPromise = null;

  async function run(reason = 'startup') {
    if (!enabled) return emptySummary();
    if (runPromise) return runPromise;
    state.running = true;
    state.lastAttemptAt = new Date().toISOString();
    runPromise = performBackfill(reason);
    try {
      return await runPromise;
    } finally {
      runPromise = null;
      state.running = false;
    }
  }

  async function performBackfill(reason) {
    const summary = emptySummary();
    try {
      const channels = await fetchRegisteredInputChannels(
        `${apiBaseUrl}/api/integrations/discord/channels`,
        fetchImpl,
        { authorization: `Bearer ${apiToken}` }
      );
      summary.channelCount = channels.length;
      for (const channel of channels) {
        await backfillChannel(channel, summary);
      }
      state.lastSuccessAt = new Date().toISOString();
      state.lastError = '';
      Object.assign(state, summary);
      logger.info(
        `Discord channel catch-up completed (${reason}): ${summary.messageCount} messages / `
        + `${summary.appliedCount} applied / ${summary.reviewCount} review / `
        + `${summary.duplicateCount} already present / ${summary.errorCount} failed`
      );
      return summary;
    } catch (error) {
      state.lastError = error.message;
      logger.error(`Discord channel catch-up failed (${reason}): ${error.message}`);
      throw error;
    }
  }

  async function backfillChannel(inputChannel, summary) {
    const channelId = inputChannel.channelId;
    const afterTimestamp = Date.parse(inputChannel.afterAt || '');
    if (!Number.isFinite(afterTimestamp)) {
      summary.errorCount += 1;
      logger.warn(`Discord channel catch-up skipped ${channelId}: no safe replay boundary`);
      return;
    }
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.messages?.fetch) {
        throw new Error('channel does not expose message history');
      }
      const fetched = await channel.messages.fetch({ limit });
      const messages = collectionValues(fetched)
        .filter(message => messageTime(message) > afterTimestamp)
        .sort((left, right) => messageTime(left) - messageTime(right));
      summary.messageCount += messages.length;
      for (const message of messages) {
        try {
          const result = await processMessage(message, {
            backfill: true,
            trackTelemetry: false,
            quietDuplicate: true
          });
          summary.payloadCount += numberOrZero(result?.payloads);
          summary.duplicateCount += numberOrZero(result?.duplicates);
          summary.appliedCount += numberOrZero(result?.applied);
          summary.reviewCount += numberOrZero(result?.review);
          summary.errorCount += numberOrZero(result?.errors);
        } catch (error) {
          summary.errorCount += 1;
          logger.warn(`Discord channel catch-up skipped message ${message?.id || 'unknown'}: ${error.message}`);
        }
      }
    } catch (error) {
      summary.errorCount += 1;
      logger.warn(`Discord channel catch-up could not read ${channelId}: ${error.message}`);
    }
  }

  function health() {
    return {
      enabled,
      limit,
      running: state.running,
      last_attempt_at: state.lastAttemptAt,
      last_success_at: state.lastSuccessAt,
      last_error: state.lastError,
      channel_count: state.channelCount,
      message_count: state.messageCount,
      payload_count: state.payloadCount,
      duplicate_count: state.duplicateCount,
      applied_count: state.appliedCount,
      review_count: state.reviewCount,
      error_count: state.errorCount
    };
  }

  return { enabled, run, health };
}

async function fetchRegisteredInputChannels(directoryUrl, fetchImpl = fetch, requestHeaders = {}) {
  const response = await fetchImpl(new URL(directoryUrl), {
    headers: { accept: 'application/json', ...requestHeaders },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Business integration directory request failed (${response.status})`);
  const payload = await response.json();
  if (!payload?.ok || !Array.isArray(payload.integrations)) {
    throw new Error(payload?.error || 'Business API did not return Discord integrations');
  }
  return registeredInputChannels(payload.integrations);
}

function registeredInputChannels(integrations) {
  const channels = new Map();
  for (const integration of Array.isArray(integrations) ? integrations : []) {
    if (String(integration?.status || 'active').trim().toLowerCase() !== 'active') continue;
    const fallback = safeTimestamp(integration.createdAt);
    addInputChannel(channels, integration.eventChannelId, integration.eventChannelBackfillAfter || fallback);
    addInputChannel(
      channels,
      integration.storageLedgerChannelId,
      integration.storageLedgerChannelBackfillAfter || fallback
    );
  }
  return [...channels.values()];
}

function addInputChannel(channels, value, afterAt) {
  const channelId = String(value || '').trim();
  if (!channelId) return;
  const boundary = safeTimestamp(afterAt);
  const current = channels.get(channelId);
  if (!current || (boundary && (!current.afterAt || Date.parse(boundary) < Date.parse(current.afterAt)))) {
    channels.set(channelId, { channelId, afterAt: boundary });
  }
}

function safeTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

async function fetchRegisteredInputChannelIds(directoryUrl, fetchImpl = fetch, requestHeaders = {}) {
  return (await fetchRegisteredInputChannels(directoryUrl, fetchImpl, requestHeaders))
    .map(channel => channel.channelId);
}

function registeredInputChannelIds(integrations) {
  return registeredInputChannels(integrations).map(channel => channel.channelId);
}

function normalizeBackfillLimit(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_BACKFILL_LIMIT;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_BACKFILL_LIMIT;
  return Math.max(0, Math.min(100, Math.floor(number)));
}

function collectionValues(collection) {
  if (Array.isArray(collection)) return [...collection];
  if (collection && typeof collection.values === 'function') return [...collection.values()];
  return [];
}

function messageTime(message) {
  const timestamp = Number(message?.createdTimestamp);
  if (Number.isFinite(timestamp)) return timestamp;
  const parsed = Date.parse(message?.createdAt || message?.timestamp || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptySummary() {
  return {
    channelCount: 0,
    messageCount: 0,
    payloadCount: 0,
    duplicateCount: 0,
    appliedCount: 0,
    reviewCount: 0,
    errorCount: 0
  };
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

module.exports = {
  createRegisteredChannelBackfill,
  fetchRegisteredInputChannels,
  fetchRegisteredInputChannelIds,
  normalizeBackfillLimit,
  registeredInputChannels,
  registeredInputChannelIds
};
