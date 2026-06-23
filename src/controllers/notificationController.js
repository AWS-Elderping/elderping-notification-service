// notificationController.js
// Controllers for handling Notification dispatches, templates, and analytics

const NotificationModel = require('../models/notificationModel');
const QueueService = require('../services/notificationQueueService');
const { getProvider } = require('../providers/providerRegistry');
const { logAuditEvent } = require('../../shared/auth');

const provider = getProvider();

const sendEmail = async (req, res) => {
  try {
    const { recipient, subject, message, scheduledFor } = req.body;
    
    const notif = await NotificationModel.createNotification({
      channel: 'EMAIL',
      recipient,
      subject,
      message,
      scheduledFor
    });

    const enqueued = QueueService.enqueue(notif.id);
    if (!enqueued) {
      return res.status(503).json({ error: 'Queue buffer is saturated. Log dropped.' });
    }

    logAuditEvent(req, {
      actionType: 'SEND_EMAIL',
      resource: 'notifications',
      resourceId: notif.id,
      status: 'SUCCESS',
      message: `Email notification queued for ${recipient}`
    });

    res.status(202).json({
      status: 'Accepted',
      message: 'Email notification enqueued successfully',
      notificationId: notif.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const sendSMS = async (req, res) => {
  try {
    const { recipient, message, scheduledFor } = req.body;

    const notif = await NotificationModel.createNotification({
      channel: 'SMS',
      recipient,
      message,
      scheduledFor
    });

    const enqueued = QueueService.enqueue(notif.id);
    if (!enqueued) {
      return res.status(503).json({ error: 'Queue buffer is saturated. Log dropped.' });
    }

    logAuditEvent(req, {
      actionType: 'SEND_SMS',
      resource: 'notifications',
      resourceId: notif.id,
      status: 'SUCCESS',
      message: `SMS notification queued for ${recipient}`
    });

    res.status(202).json({
      status: 'Accepted',
      message: 'SMS notification enqueued successfully',
      notificationId: notif.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const sendBulk = async (req, res) => {
  try {
    // Increment bulk request Prometheus counter
    QueueService.metrics.bulkRequestsCounter.inc();

    const { items } = req.body;
    let acceptedCount = 0;
    let rejectedCount = 0;
    let queuedCount = 0;
    const details = [];

    for (const item of items) {
      try {
        const notif = await NotificationModel.createNotification({
          channel: item.channel.toUpperCase(),
          recipient: item.recipient,
          subject: item.subject,
          message: item.message,
          scheduledFor: item.scheduledFor
        });

        const enqueued = QueueService.enqueue(notif.id);
        if (enqueued) {
          acceptedCount++;
          queuedCount++;
          details.push({ recipient: item.recipient, status: 'QUEUED', id: notif.id });
        } else {
          rejectedCount++;
          details.push({ recipient: item.recipient, status: 'REJECTED', reason: 'Queue saturated' });
        }
      } catch (err) {
        rejectedCount++;
        details.push({ recipient: item.recipient, status: 'REJECTED', reason: err.message });
      }
    }

    logAuditEvent(req, {
      actionType: 'SEND_BULK_NOTIFICATION',
      resource: 'notifications',
      status: 'SUCCESS',
      message: `Processed bulk dispatch: enqueued ${queuedCount}, rejected ${rejectedCount}`
    });

    res.status(202).json({
      acceptedCount,
      rejectedCount,
      queuedCount,
      details
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const notif = await NotificationModel.getById(id);
    if (!notif) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    logAuditEvent(req, {
      actionType: 'VIEW_NOTIFICATION',
      resource: 'notifications',
      resourceId: id,
      status: 'SUCCESS',
      message: `Viewed notification details for ID: ${id}`
    });

    res.json(notif);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const listNotifications = async (req, res) => {
  try {
    const { status, channel, provider, recipient, startDate, endDate, page, limit } = req.query;
    const result = await NotificationModel.searchNotifications({
      status,
      channel,
      provider,
      recipient,
      startDate,
      endDate,
      page,
      limit
    });

    logAuditEvent(req, {
      actionType: 'VIEW_NOTIFICATIONS',
      resource: 'notifications',
      status: 'SUCCESS',
      message: 'Viewed notifications search list'
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const retryNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const notif = await NotificationModel.getById(id);
    if (!notif) return res.status(404).json({ error: 'Notification not found' });

    // Reset status and retry counter
    const updated = await NotificationModel.updateStatus(id, {
      status: 'PENDING',
      retryCount: 0,
      errorMessage: null,
      scheduledFor: null
    });

    QueueService.enqueue(id);

    logAuditEvent(req, {
      actionType: 'RETRY_NOTIFICATION',
      resource: 'notifications',
      resourceId: id,
      status: 'SUCCESS',
      message: `Triggered sending retry for notification ID: ${id}`
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const providerStatus = async (req, res) => {
  try {
    const isHealthy = await provider.healthCheck();
    const queueStats = QueueService.getQueueStats();
    const dlqDepth = await NotificationModel.getDLQDepth();
    const providerType = process.env.NOTIFICATION_PROVIDER || 'mock';

    logAuditEvent(req, {
      actionType: 'VIEW_PROVIDER_STATUS',
      resource: 'notification_provider',
      status: 'SUCCESS',
      message: 'Viewed notification provider configurations status'
    });

    res.json({
      provider: providerType,
      status: isHealthy ? 'healthy' : 'degraded',
      configurationValid: isHealthy,
      lastSuccessfulSend: queueStats.lastProcessedAt,
      queueDepth: queueStats.queueDepth,
      dlqDepth,
      workerRunning: queueStats.workerRunning,
      workerRestarts: queueStats.workerRestarts,
      lastProcessedAt: queueStats.lastProcessedAt
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getStats = async (req, res) => {
  try {
    const stats = await NotificationModel.getStats();

    logAuditEvent(req, {
      actionType: 'VIEW_NOTIFICATION_STATS',
      resource: 'notifications',
      status: 'SUCCESS',
      message: 'Viewed notification aggregated counts'
    });

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getAnalytics = async (req, res) => {
  try {
    const analytics = await NotificationModel.getAnalytics();

    logAuditEvent(req, {
      actionType: 'VIEW_ANALYTICS',
      resource: 'notifications',
      status: 'SUCCESS',
      message: 'Viewed notifications analytics dashboard'
    });

    res.json(analytics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Dead Letter Queue Handler
const getDLQ = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || 50, 10);
    const offset = parseInt(req.query.offset || 0, 10);
    const events = await NotificationModel.getDLQEvents(limit, offset);
    res.json({ events });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Templates CRUD handlers
const listTemplates = async (req, res) => {
  try {
    const templates = await NotificationModel.getTemplates();
    res.json(templates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const template = await NotificationModel.getTemplateById(id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createTemplate = async (req, res) => {
  try {
    const { name, channel, subjectTemplate, bodyTemplate } = req.body;
    if (!name || !channel || !bodyTemplate) {
      return res.status(400).json({ error: 'name, channel, and bodyTemplate are required' });
    }

    const created = await NotificationModel.createTemplate({
      name,
      channel: channel.toUpperCase(),
      subjectTemplate,
      bodyTemplate
    });

    logAuditEvent(req, {
      actionType: 'CRUD_TEMPLATE',
      resource: 'notification_templates',
      resourceId: created.id,
      status: 'SUCCESS',
      message: `Created notification template: ${name}`
    });

    res.status(201).json(created);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, channel, subjectTemplate, bodyTemplate } = req.body;
    if (!name || !channel || !bodyTemplate) {
      return res.status(400).json({ error: 'name, channel, and bodyTemplate are required' });
    }

    const updated = await NotificationModel.updateTemplate(id, {
      name,
      channel: channel.toUpperCase(),
      subjectTemplate,
      bodyTemplate
    });

    if (!updated) return res.status(404).json({ error: 'Template not found' });

    logAuditEvent(req, {
      actionType: 'CRUD_TEMPLATE',
      resource: 'notification_templates',
      resourceId: id,
      status: 'SUCCESS',
      message: `Updated notification template: ${name}`
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await NotificationModel.deleteTemplate(id);
    if (!deleted) return res.status(404).json({ error: 'Template not found' });

    logAuditEvent(req, {
      actionType: 'CRUD_TEMPLATE',
      resource: 'notification_templates',
      resourceId: id,
      status: 'SUCCESS',
      message: `Deleted notification template ID: ${id}`
    });

    res.json({ message: 'Template deleted successfully', deleted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  sendEmail,
  sendSMS,
  sendBulk,
  getNotification,
  listNotifications,
  retryNotification,
  providerStatus,
  getStats,
  getAnalytics,
  getDLQ,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate
};
