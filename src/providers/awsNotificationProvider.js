// awsNotificationProvider.js
// AWS SESv2 and SNS Client implementation of NotificationProvider

const NotificationProviderInterface = require('./notificationProviderInterface');
const { SESv2Client, SendEmailCommand, GetAccountCommand } = require('@aws-sdk/client-sesv2');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

class AwsNotificationProvider extends NotificationProviderInterface {
  constructor() {
    super();
    this.awsRegion = process.env.AWS_REGION || 'us-east-1';
    this.sesSourceEmail = process.env.SES_SOURCE_EMAIL || 'alerts@elderpinq.com';

    try {
      this.sesClient = new SESv2Client({ region: this.awsRegion });
      this.snsClient = new SNSClient({ region: this.awsRegion });
    } catch (err) {
      console.error('⚠️ AwsNotificationProvider failed to initialize AWS clients:', err.message);
      this.sesClient = null;
      this.snsClient = null;
    }
  }

  async sendEmail(recipient, subject, body) {
    if (!this.sesClient) {
      throw new Error('AWS SESv2Client is not initialized.');
    }

    const command = new SendEmailCommand({
      FromEmailAddress: this.sesSourceEmail,
      Destination: {
        ToAddresses: [recipient]
      },
      Content: {
        Simple: {
          Subject: { Data: subject },
          Body: { Text: { Data: body } }
        }
      }
    });

    const response = await this.sesClient.send(command);
    return {
      messageId: response.MessageId,
      status: 'SENT'
    };
  }

  async sendSMS(phone, body) {
    if (!this.snsClient) {
      throw new Error('AWS SNSClient is not initialized.');
    }

    const command = new PublishCommand({
      PhoneNumber: phone,
      Message: body,
      MessageAttributes: {
        'AWS.MM.SMS.SenderID': { DataType: 'String', StringValue: 'ElderPinq' }
      }
    });

    const response = await this.snsClient.send(command);
    return {
      messageId: response.MessageId,
      status: 'SENT'
    };
  }

  async healthCheck() {
    try {
      if (!this.sesClient || !this.snsClient) return false;
      
      // Perform lightweight SES API check to verify connectivity
      const sesCmd = new GetAccountCommand({});
      await this.sesClient.send(sesCmd);
      return true;
    } catch (err) {
      console.error('⚠️ AWS Provider connectivity check failed:', err.message);
      return false;
    }
  }
}

module.exports = AwsNotificationProvider;
