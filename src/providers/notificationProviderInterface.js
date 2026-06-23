// notificationProviderInterface.js
// Interface defining abstraction layer for sending notifications

class NotificationProviderInterface {
  /**
   * Sends an email notification.
   * @param {String} recipient 
   * @param {String} subject 
   * @param {String} body 
   * @returns {Promise<Object>}
   */
  async sendEmail(recipient, subject, body) {
    throw new Error('Method sendEmail() must be implemented.');
  }

  /**
   * Sends an SMS notification.
   * @param {String} phone 
   * @param {String} body 
   * @returns {Promise<Object>}
   */
  async sendSMS(phone, body) {
    throw new Error('Method sendSMS() must be implemented.');
  }

  /**
   * Performs provider connectivity check.
   * @returns {Promise<Boolean>}
   */
  async healthCheck() {
    throw new Error('Method healthCheck() must be implemented.');
  }
}

module.exports = NotificationProviderInterface;
