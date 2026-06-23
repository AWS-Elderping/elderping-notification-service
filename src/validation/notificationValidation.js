// notificationValidation.js
// Validation rules for Notification Service inputs

const validateEmailPayload = (req, res, next) => {
  const { recipient, message } = req.body;

  if (!recipient || typeof recipient !== 'string' || !recipient.includes('@')) {
    return res.status(400).json({ error: "Validation failed: 'recipient' is required and must be a valid email address." });
  }

  if (!message || typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ error: "Validation failed: 'message' is required and must be a non-empty string." });
  }

  next();
};

const validateSMSPayload = (req, res, next) => {
  const { recipient, message } = req.body;

  if (!recipient || typeof recipient !== 'string' || recipient.trim() === '') {
    return res.status(400).json({ error: "Validation failed: 'recipient' (phone number) is required and must be a string." });
  }

  if (!message || typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ error: "Validation failed: 'message' is required and must be a non-empty string." });
  }

  next();
};

const validateBulkPayload = (req, res, next) => {
  const { items } = req.body;
  const maxBulk = parseInt(process.env.MAX_BULK_RECIPIENTS || '500', 10);

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: "Validation failed: 'items' is required and must be an array of notifications." });
  }

  if (items.length > maxBulk) {
    return res.status(400).json({ 
      error: `Validation failed: Bulk size exceeds maximum allowed threshold of ${maxBulk} recipients.` 
    });
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.channel || !['EMAIL', 'SMS'].includes(item.channel.toUpperCase())) {
      return res.status(400).json({ error: `Validation failed at item index ${i}: 'channel' must be EMAIL or SMS.` });
    }
    if (!item.recipient || typeof item.recipient !== 'string' || item.recipient.trim() === '') {
      return res.status(400).json({ error: `Validation failed at item index ${i}: 'recipient' is required.` });
    }
    if (!item.message || typeof item.message !== 'string' || item.message.trim() === '') {
      return res.status(400).json({ error: `Validation failed at item index ${i}: 'message' is required.` });
    }
  }

  next();
};

module.exports = {
  validateEmailPayload,
  validateSMSPayload,
  validateBulkPayload
};
