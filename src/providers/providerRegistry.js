// providerRegistry.js
// Factory to retrieve initialized Notification provider dynamically based on environment

const getProvider = () => {
  const providerType = (process.env.NOTIFICATION_PROVIDER || 'mock').toLowerCase();

  if (providerType === 'aws') {
    console.log('🔌 Notification Service: Initializing AWS Provider');
    const AwsNotificationProvider = require('./awsNotificationProvider');
    return new AwsNotificationProvider();
  }

  console.log('🔌 Notification Service: Initializing Mock Provider');
  const MockNotificationProvider = require('./mockNotificationProvider');
  return new MockNotificationProvider();
};

module.exports = { getProvider };
