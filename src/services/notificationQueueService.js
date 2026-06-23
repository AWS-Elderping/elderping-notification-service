// notificationQueueService.js
// Asynchronous delivery queue service with self-healing background worker and DLQ integration

const client = require('prom-client');
const NotificationModel = require('../models/notificationModel');
const { getProvider } = require('../providers/providerRegistry');
const { logAuditEvent } = require('../../shared/auth');

const provider = getProvider();

// Prometheus Metrics Declarations
const sentCounter = new client.Counter({
  name: 'notification_sent_total',
  help: 'Total number of successfully sent notifications'
});

const failedCounter = new client.Counter({
  name: 'notification_failed_total',
  help: 'Total number of failed notifications'
});

const pendingGauge = new client.Gauge({
  name: 'notification_pending_total',
  help: 'Current count of pending notifications in the database'
});

const retryCounter = new client.Counter({
  name: 'notification_retry_total',
  help: 'Total number of sending retries performed'
});

const queueDepthGauge = new client.Gauge({
  name: 'notification_queue_depth',
  help: 'Current depth of the notification queue buffer'
});

const dlqCounter = new client.Counter({
  name: 'notification_dlq_total',
  help: 'Total notifications moved to the Dead Letter Queue (DLQ)'
});

const providerErrorsCounter = new client.Counter({
  name: 'notification_provider_errors_total',
  help: 'Total errors encountered from SESv2/SNS providers'
});

const bulkRequestsCounter = new client.Counter({
  name: 'notification_bulk_requests_total',
  help: 'Total bulk notification dispatch requests'
});

const emailCounter = new client.Counter({
  name: 'notification_email_total',
  help: 'Total email notifications processed'
});

const smsCounter = new client.Counter({
  name: 'notification_sms_total',
  help: 'Total SMS notifications processed'
});

const droppedCounter = new client.Counter({
  name: 'notification_dropped_total',
  help: 'Total notifications dropped due to queue saturation'
});

const MAX_QUEUE_SIZE = 10000;
const FLUSH_THRESHOLD = 100;
const FLUSH_INTERVAL = 5000; // 5 seconds

let queue = [];
let isFlushing = false;
let workerIntervalId = null;
let healthIntervalId = null;
let workerRestarts = 0;
let lastProcessedAt = null;

const getPreferencesForRecipient = async (recipient, channel) => {
  // Query to find user preferences. Since we resolve user profiles from auth-service,
  // we attempt lookup. If auth-service is unavailable, fallback to DB preferences check.
  const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://auth-service:3000';
  const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
  try {
    const res = await fetch(`${authServiceUrl}/users/find?q=${encodeURIComponent(recipient)}`);
    if (res.ok) {
      const user = await res.json();
      if (user && user.id) {
        const prefs = await NotificationModel.getPreferences(user.id);
        return prefs;
      }
    }
  } catch (err) {
    console.warn(`[PREFERENCES LOOKUP WARNING] Failed to fetch user preferences cross-service: ${err.message}`);
  }
  return null;
};

const NotificationQueueService = {
  /**
   * Enqueues a notification job.
   * If capacity exceeded, drops event and increments metric.
   * @param {String} notificationId 
   */
  enqueue(notificationId) {
    if (queue.length >= MAX_QUEUE_SIZE) {
      droppedCounter.inc();
      console.warn(`[QUEUE SATURATION WARNING] Queue exceeds ${MAX_QUEUE_SIZE}. Dropping notification ID: ${notificationId}`);
      return false;
    }

    queue.push(notificationId);
    queueDepthGauge.set(queue.length);

    if (queue.length >= FLUSH_THRESHOLD) {
      this.flushQueue();
    }
    return true;
  },

  /**
   * Process pending items in batch sequentially.
   */
  async flushQueue() {
    if (isFlushing) return;
    isFlushing = true;

    try {
      // 1. Pull due pending notifications from PostgreSQL to also process scheduled events
      const dueDbRows = await NotificationModel.getDuePendingNotifications();
      for (const row of dueDbRows) {
        if (!queue.includes(row.id)) {
          queue.push(row.id);
        }
      }
      queueDepthGauge.set(queue.length);
    } catch (err) {
      console.error('⚠️ [QUEUE WORKER ERROR] Failed to query due notifications from database:', err.message);
    }

    const batch = [...queue];
    queue = [];
    queueDepthGauge.set(0);

    for (const notifId of batch) {
      try {
        await this.processNotification(notifId);
      } catch (err) {
        console.error(`⚠️ [QUEUE WORKER ERROR] Failed to process notification ${notifId}:`, err.message);
      }
    }

    lastProcessedAt = new Date();
    isFlushing = false;
  },

  async processNotification(notifId) {
    const notif = await NotificationModel.getById(notifId);
    if (!notif) return;

    if (notif.status !== 'PENDING' && notif.status !== 'PROCESSING') return;

    // Ignore scheduled notifications in the future
    if (notif.scheduled_for && new Date(notif.scheduled_for) > new Date()) {
      return;
    }

    // Set status to PROCESSING
    await NotificationModel.updateStatus(notifId, { status: 'PROCESSING' });

    // Validate user notification preferences
    const prefs = await getPreferencesForRecipient(notif.recipient, notif.channel);
    if (prefs) {
      const isEmailDisabled = notif.channel === 'EMAIL' && !prefs.email_enabled;
      const isSMSDisabled = notif.channel === 'SMS' && !prefs.sms_enabled;

      if (isEmailDisabled || isSMSDisabled) {
        console.log(`[PREFERENCE SKIP] Skipping dispatch to ${notif.recipient} per user settings.`);
        await NotificationModel.updateStatus(notifId, { 
          status: 'SKIPPED', 
          errorMessage: 'Skipped send: channel disabled in notification preferences.' 
        });
        return;
      }
    }

    // Send through provider
    try {
      if (notif.channel === 'EMAIL') {
        emailCounter.inc();
        await provider.sendEmail(notif.recipient, notif.subject || 'ElderPing Alert', notif.message);
      } else {
        smsCounter.inc();
        await provider.sendSMS(notif.recipient, notif.message);
      }

      // Success
      await NotificationModel.updateStatus(notifId, { status: 'SENT', sentAt: new Date() });
      sentCounter.inc();
    } catch (err) {
      providerErrorsCounter.inc();
      console.error(`⚠️ Provider send failed for notification ${notifId}:`, err.message);

      const maxRetries = 3;
      if (notif.retry_count < maxRetries) {
        // Schedule retry with exponential backoff (1s, 2s, 4s)
        const attempt = notif.retry_count + 1;
        const delayMs = attempt === 1 ? 1000 : (attempt === 2 ? 2000 : 4000);
        const scheduledFor = new Date(Date.now() + delayMs);

        await NotificationModel.updateStatus(notifId, {
          status: 'PENDING',
          retryCount: attempt,
          errorMessage: err.message,
          scheduledFor
        });

        retryCounter.inc();
        console.log(`⏳ Scheduled attempt #${attempt} retry for notification ${notifId} in ${delayMs}ms`);
      } else {
        // Move to DLQ database table
        await NotificationModel.updateStatus(notifId, { 
          status: 'FAILED', 
          errorMessage: `Failed after ${maxRetries} attempts: ${err.message}` 
        });

        await NotificationModel.moveToDLQ({
          notificationId: notifId,
          reason: err.message,
          payload: notif
        });

        failedCounter.inc();
        dlqCounter.inc();
        console.warn(`🚨 Notification ${notifId} exceeded max retries. Moved to Dead Letter Queue (DLQ).`);
      }
    }
  },

  /**
   * Starts queue flushing loop and worker self-healing health monitor.
   */
  startWorker() {
    if (workerIntervalId) return;

    console.log(`🚀 Starting Notification Queue Worker (interval: ${FLUSH_INTERVAL}ms)`);
    workerIntervalId = setInterval(() => {
      this.flushQueue();
    }, FLUSH_INTERVAL);

    // Self-healing check loop runs every 10 seconds
    healthIntervalId = setInterval(() => {
      this.checkWorkerHealth();
    }, 10000);
  },

  stopWorker() {
    if (workerIntervalId) {
      clearInterval(workerIntervalId);
      workerIntervalId = null;
    }
    if (healthIntervalId) {
      clearInterval(healthIntervalId);
      healthIntervalId = null;
    }
  },

  /**
   * Restarts the worker if it gets stuck or stops processing items.
   */
  checkWorkerHealth() {
    const now = Date.now();
    const isHung = queue.length > 0 && lastProcessedAt && (now - lastProcessedAt.getTime() > 15000);

    if (!workerIntervalId || isHung) {
      console.warn('⚠️ [WORKER HEALTH WARNING] Notification worker detected as inactive. Auto-restarting...');
      workerRestarts++;

      // Log recovery audit event (fire-and-forget)
      logAuditEvent({
        action: 'QUEUE_WORKER_RECOVERY',
        resource: 'notification_queue_worker',
        metadata: { restarts: workerRestarts, queueSize: queue.length }
      });

      this.stopWorker();
      this.startWorker();
    }
  },

  getQueueStats() {
    return {
      queueDepth: queue.length,
      workerRunning: !!workerIntervalId,
      workerRestarts,
      lastProcessedAt: lastProcessedAt ? lastProcessedAt.toISOString() : null
    };
  },

  metrics: {
    sentCounter,
    failedCounter,
    pendingGauge,
    retryCounter,
    queueDepthGauge,
    dlqCounter,
    providerErrorsCounter,
    bulkRequestsCounter,
    emailCounter,
    smsCounter,
    droppedCounter
  }
};

module.exports = NotificationQueueService;
