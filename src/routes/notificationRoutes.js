// notificationRoutes.js
// Express Router definitions for Notification Service endpoints

const express = require('express');
const router = express.Router();
const controller = require('../controllers/notificationController');
const { authenticate, requirePermission } = require('../../shared/auth');
const rateLimiter = require('../middleware/rateLimiter');
const validation = require('../validation/notificationValidation');

// Read-only APIs (NOTIFICATION_READ)
router.get('/', authenticate, requirePermission('NOTIFICATION_READ'), controller.listNotifications);
router.get('/stats', authenticate, requirePermission('NOTIFICATION_READ'), controller.getStats);
router.get('/analytics', authenticate, requirePermission('NOTIFICATION_READ'), controller.getAnalytics);
router.get('/provider-status', authenticate, requirePermission('NOTIFICATION_READ'), controller.providerStatus);
router.get('/:id', authenticate, requirePermission('NOTIFICATION_READ'), controller.getNotification);

// Write and Dispatch APIs (NOTIFICATION_MANAGE)
router.post('/email', authenticate, requirePermission('NOTIFICATION_MANAGE'), rateLimiter('EMAIL'), validation.validateEmailPayload, controller.sendEmail);
router.post('/sms', authenticate, requirePermission('NOTIFICATION_MANAGE'), rateLimiter('SMS'), validation.validateSMSPayload, controller.sendSMS);
router.post('/bulk', authenticate, requirePermission('NOTIFICATION_MANAGE'), rateLimiter('BULK'), validation.validateBulkPayload, controller.sendBulk);
router.post('/:id/retry', authenticate, requirePermission('NOTIFICATION_MANAGE'), controller.retryNotification);

// Scheduled Sends
router.post('/schedule/email', authenticate, requirePermission('NOTIFICATION_MANAGE'), rateLimiter('EMAIL'), validation.validateEmailPayload, controller.sendEmail);
router.post('/schedule/sms', authenticate, requirePermission('NOTIFICATION_MANAGE'), rateLimiter('SMS'), validation.validateSMSPayload, controller.sendSMS);

// Dead Letter Queue Event Inspection
router.get('/dead-letter-queue', authenticate, requirePermission('NOTIFICATION_MANAGE'), controller.getDLQ);

// CRUD Notification Templates
router.get('/templates', authenticate, requirePermission('NOTIFICATION_MANAGE'), controller.listTemplates);
router.get('/templates/:id', authenticate, requirePermission('NOTIFICATION_MANAGE'), controller.getTemplate);
router.post('/templates', authenticate, requirePermission('NOTIFICATION_MANAGE'), controller.createTemplate);
router.put('/templates/:id', authenticate, requirePermission('NOTIFICATION_MANAGE'), controller.updateTemplate);
router.delete('/templates/:id', authenticate, requirePermission('NOTIFICATION_MANAGE'), controller.deleteTemplate);

module.exports = router;
