// mockNotificationProvider.js
// Mock implementation of NotificationProvider

const NotificationProviderInterface = require('./notificationProviderInterface');

class MockNotificationProvider extends NotificationProviderInterface {
  async sendEmail(recipient, subject, body) {
    console.log(`[MOCK EMAIL] To: ${recipient}, Subject: ${subject}\nBody:\n${body}`);
    return {
      messageId: `mock-email-${Math.random().toString(36).substring(2, 11)}`,
      status: 'SENT'
    };
  }

  async sendSMS(phone, body) {
    console.log(`[MOCK SMS] To: ${phone}, Message: ${body}`);
    return {
      messageId: `mock-sms-${Math.random().toString(36).substring(2, 11)}`,
      status: 'SENT'
    };
  }

  async healthCheck() {
    return true;
  }
}

module.exports = MockNotificationProvider;
