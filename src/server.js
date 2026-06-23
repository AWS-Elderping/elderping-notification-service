// server.js
// ElderPing Notification Service entrypoint

const express = require('express');
const cors = require('cors');
const notificationRoutes = require('./routes/notificationRoutes');
const QueueService = require('./services/notificationQueueService');
const NotificationModel = require('./models/notificationModel');
const client = require('prom-client');
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { validateToken, checkRelationship } = require('./authMiddleware');

const app = express();
app.use(cors());
app.use(express.json());

// Enable default system metrics collection
client.collectDefaultMetrics();

// Liveness probe (must be before path-rewrite middleware)
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', service: 'notification-service' }));
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok', service: 'notification-service' }));
app.get('/ready', (req, res) => res.status(200).json({ status: 'ok', service: 'notification-service' }));

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// K8s ALB path prefix compatibility: strip /api/notifications prefix
app.use((req, _res, next) => {
  if (req.url.startsWith('/api/notifications') || req.url.startsWith('/api/notification')) {
    req.url = req.url.replace(/^\/api\/notification[s]?/, '') || '/';
  }
  next();
});

// Mount modular endpoints under /notifications
app.use('/notifications', notificationRoutes);

// Core dispatch adapter for backwards compatibility with the SQS background poller
async function handleNotificationDispatch(userId, type, payload) {
  if (!userId || !type || !payload) {
    throw new Error('userId, type, and payload are required');
  }

  const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://auth-service:3000';
  const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
  
  const userResponse = await fetch(`${authServiceUrl}/users/${userId}`);
  if (!userResponse.ok) {
    throw new Error(`User contact details not found for user: ${userId}`);
  }
  const user = await userResponse.json();

  const emailRecipient = user.email || `${user.username}@elderpinq.com`;
  const phoneRecipient = user.phone || '+15550199';

  // Get Preferences from DB (fallback to default)
  let prefs = { 
    email_enabled: true, 
    sms_enabled: false, 
    whatsapp_enabled: false,
    reports_enabled: true,
    appointments_enabled: true,
    medication_enabled: true,
    emergency_enabled: true
  };
  
  const pool = NotificationModel.getPool();
  const prefsRes = await pool.query('SELECT * FROM notification_preferences WHERE user_id = $1', [userId]);
  if (prefsRes.rows.length > 0) {
    prefs = { ...prefs, ...prefsRes.rows[0] };
  }

  // Granular preference checks
  let topicEnabled = true;
  if (type.startsWith('APPOINTMENT_')) {
    topicEnabled = prefs.appointments_enabled;
  } else if (type.startsWith('MEDICATION_') || type === 'LOW_STOCK_ALERT') {
    topicEnabled = prefs.medication_enabled;
  } else if (type === 'WEEKLY_REPORT') {
    topicEnabled = prefs.reports_enabled;
  } else if (type === 'EMERGENCY_ALERT' || type === 'FALL_DETECTION') {
    topicEnabled = prefs.emergency_enabled;
  }

  if (!topicEnabled) {
    console.log(`[PREFERENCE FILTER] Topic ${type} is disabled for user ${userId}. Skipping dispatch.`);
    return { status: 'SKIPPED', reason: 'Topic preference disabled' };
  }

  let subject = 'ElderPinq Alert Update';
  let body = `Hello ${user.username || 'User'},\n\n`;

  if (type === 'APPOINTMENT_BOOKED') {
    subject = `Appointment Confirmed: Dr. ${payload.doctorName}`;
    body += `A medical appointment has been scheduled with Dr. ${payload.doctorName} at ${payload.clinicName || 'Clinic'}.\nDate/Time: ${payload.scheduledAt}.`;
  } else if (type === 'APPOINTMENT_RESCHEDULED') {
    subject = `Appointment Rescheduled: Dr. ${payload.doctorName}`;
    body += `Your medical appointment with Dr. ${payload.doctorName} has been rescheduled.\nNew Date/Time: ${payload.scheduledAt}\nClinic: ${payload.clinicName || 'Clinic'}.`;
  } else if (type === 'APPOINTMENT_CANCELLED') {
    subject = `Appointment CANCELLED: Dr. ${payload.doctorName}`;
    body += `Your medical appointment with Dr. ${payload.doctorName} has been CANCELLED.\nReason: ${payload.cancellationReason || 'No reason provided'}.`;
  } else if (type === 'APPOINTMENT_REMINDER') {
    const label = payload.reminderType ? `(${payload.reminderType} reminder)` : '';
    subject = `Upcoming Appointment Reminder ${label}: Dr. ${payload.doctorName}`;
    body += `This is a reminder that you have an upcoming medical appointment with Dr. ${payload.doctorName} scheduled at ${payload.scheduledAt} at ${payload.clinicName || 'Clinic'}.`;
  } else if (type === 'WEEKLY_REPORT') {
    subject = 'Weekly Health Summary Compiled';
    body += `Your weekly health metrics analysis is complete.\nYou can download your report details at: https://elderpinq.com/reports/${payload.reportId}`;
  } else if (type === 'HEALTH_ALERT') {
    subject = `⚠️ CRITICAL: Health Alert Logged`;
    body += `An alert was flagged for you.\nDetails: ${payload.message}\nSeverity: ${payload.severity}`;
  } else if (type === 'MEDICATION_REMINDER') {
    subject = `Medication Reminder: ${payload.medicationName}`;
    body += `It is time to take ${payload.medicationName} (${payload.dosage || '1 dose'}). Scheduled time was: ${payload.scheduledTime}.`;
  } else if (type === 'LOW_STOCK_ALERT') {
    subject = `⚠️ Low Stock Warning: ${payload.medicationName}`;
    body += `Medication inventory for ${payload.medicationName} is low (Current stock: ${payload.currentStock}, threshold: ${payload.lowStockThreshold}). Please replenish soon.`;
  } else if (type === 'EMERGENCY_ALERT') {
    subject = `🚨 CRITICAL EMERGENCY ALERT`;
    body += `An emergency alert has been triggered!\nIncident details: ${payload.message}`;
  } else if (type === 'MISSED_CHECKIN') {
    subject = `⚠️ Alert: Missed Daily Check-In`;
    body += `An elder has missed their daily scheduled health check-in. Please contact them or verify status immediately.`;
  } else if (type === 'FAMILY_NOTIFICATION') {
    subject = payload.subject || 'Family Health Update';
    body += payload.message || 'There is a new update regarding your linked elder.';
  } else if (type === 'FALL_DETECTION') {
    subject = `🚨 URGENT: Fall Event Detected`;
    body += `A fall sensor alert has been logged at ${payload.timestamp || 'now'}!\nImpact force: ${payload.impactForce || 'N/A'}G. Immediate verification required.`;
  } else {
    body += `A notification has been triggered: ${JSON.stringify(payload)}`;
  }

  body += `\n\nBest wishes,\nElderPinq Operations Team.`;

  // Enqueue via modern MVC delivery engine
  if (prefs.email_enabled) {
    const notif = await NotificationModel.createNotification({
      channel: 'EMAIL',
      recipient: emailRecipient,
      subject,
      message: body
    });
    QueueService.enqueue(notif.id);
  }

  if (prefs.sms_enabled || prefs.whatsapp_enabled) {
    const notif = await NotificationModel.createNotification({
      channel: 'SMS',
      recipient: phoneRecipient,
      message: body
    });
    QueueService.enqueue(notif.id);
  }

  return { status: 'DISPATCHED' };
}

// Preserve existing trigger endpoint for internal system triggers
app.post('/notifications/trigger', validateToken, checkRelationship('userId'), async (req, res) => {
  try {
    const { userId, type, payload } = req.body;
    const result = await handleNotificationDispatch(userId, type, payload);
    res.json({ message: 'Notifications dispatch completed', result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SQS Queue polling consumer implementation
let isPollingActive = true;
const queueUrl = process.env.SQS_QUEUE_URL;

const shouldContinuePolling = () => isPollingActive;

async function processQueueMessage(body) {
  console.log('📬 SQS Message received:', JSON.stringify(body));
  let type = null;
  let payload = null;
  let userId = null;

  if (body['detail-type'] && body.detail) {
    const detailType = body['detail-type'];
    const detail = typeof body.detail === 'string' ? JSON.parse(body.detail) : body.detail;
    
    if (detailType === 'BOOK_APPOINTMENT') type = 'APPOINTMENT_BOOKED';
    else if (detailType === 'RESCHEDULE_APPOINTMENT') type = 'APPOINTMENT_RESCHEDULED';
    else if (detailType === 'CANCEL_APPOINTMENT') type = 'APPOINTMENT_CANCELLED';
    else type = detailType;

    payload = detail;
    userId = detail.elderId;
  } else if (body.type) {
    type = body.type;
    payload = body;
    userId = body.elderId;
  }
  
  if (userId && type && payload) {
    await handleNotificationDispatch(userId, type, payload);
    console.log(`✅ Queue event ${type} successfully processed for user: ${userId}`);
  } else {
    console.log('⚠️ SQS Message format not recognized. Skipping.');
  }
}

async function startSQSPoller() {
  const awsRegion = process.env.AWS_REGION || 'us-east-1';
  let sqsClient = null;

  try {
    if (process.env.NOTIFICATION_PROVIDER === 'aws' && queueUrl) {
      sqsClient = new SQSClient({ region: awsRegion });
    }
  } catch (err) {
    console.warn('⚠️ SQS Poller failed to initialize SQSClient:', err.message);
  }

  if (!sqsClient || !queueUrl) {
    console.log('ℹ️ Background SQS poller not active (running locally or provider=mock).');
    return;
  }

  console.log(`🚀 Starting SQS Polling Worker for queue: ${queueUrl}`);
  while (shouldContinuePolling()) {
    try {
      const command = new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 5,
        WaitTimeSeconds: 15
      });
      const response = await sqsClient.send(command);
      if (response.Messages && response.Messages.length > 0) {
        for (const msg of response.Messages) {
          try {
            const body = JSON.parse(msg.Body);
            await processQueueMessage(body);
            
            const deleteCmd = new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: msg.ReceiptHandle
            });
            await sqsClient.send(deleteCmd);
          } catch (err) {
            console.error('⚠️ Error processing SQS message:', err.message);
          }
        }
      }
    } catch (err) {
      console.error('⚠️ SQS polling encountered an error. Retrying in 10s...', err.message);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
}

const PORT = process.env.PORT || 3000;

async function start() {
  const pool = NotificationModel.getPool();
  let retries = 5;

  while (retries--) {
    try {
      await pool.query('SELECT 1');
      console.log('✅ Connected to Notification database successfully.');
      break;
    } catch (err) {
      console.log(`⏳ Waiting for database… (${retries} retries left) error: ${err.message}`);
      if (retries === 0) {
        console.error('❌ Could not connect to database. Starting server anyway...');
      } else {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  // Start background queue worker
  QueueService.startWorker();

  const server = app.listen(PORT, () => {
    console.log(`Notification service running on port ${PORT}`);
    // Start background SQS queue poller
    startSQSPoller();
  });

  // Graceful shutdown handling
  const shutdown = () => {
    console.log('🛑 Shutting down Notification Service. Cleaning queue worker and DB...');
    isPollingActive = false;
    QueueService.stopWorker();

    server.close(() => {
      console.log('HTTP server closed.');
      pool.end(() => {
        console.log('Database pool closed.');
        process.exit(0);
      });
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
