function createCaptureRecord(message, source) {
  return {
    parser_profile: 'still-water',
    discord_message_id: message.id || '',
    discord_channel_id: message.channelId || '',
    webhook_id: message.webhookId || '',
    timestamp: toIsoTimestamp(message.createdAt),
    title: source.title || '',
    description: source.description || ''
  };
}

function toIsoTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  const parsed = new Date(value || 0);
  return Number.isNaN(parsed.valueOf()) ? '' : parsed.toISOString();
}

module.exports = {
  createCaptureRecord
};
