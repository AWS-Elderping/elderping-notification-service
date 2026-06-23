// notificationModel.js
// Data layer for Notification Service PostgreSQL database operations

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const NotificationModel = {
  async createNotification(data) {
    const providerType = process.env.NOTIFICATION_PROVIDER || 'mock';
    const result = await pool.query(
      `INSERT INTO notifications (channel, recipient, subject, message, provider, status, scheduled_for)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6) RETURNING *`,
      [data.channel, data.recipient, data.subject || null, data.message, providerType, data.scheduledFor || null]
    );
    return result.rows[0];
  },

  async updateStatus(id, updates) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    for (const key of Object.keys(updates)) {
      let dbCol = '';
      if (key === 'status') dbCol = 'status';
      else if (key === 'retryCount') dbCol = 'retry_count';
      else if (key === 'errorMessage') dbCol = 'error_message';
      else if (key === 'sentAt') dbCol = 'sent_at';
      else if (key === 'scheduledFor') dbCol = 'scheduled_for';

      if (dbCol) {
        fields.push(`${dbCol} = $${paramIndex}`);
        values.push(updates[key]);
        paramIndex++;
      }
    }

    if (fields.length === 0) return null;

    values.push(id);
    const query = `UPDATE notifications SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
    const res = await pool.query(query, values);
    return res.rows[0];
  },

  async getById(id) {
    const res = await pool.query('SELECT * FROM notifications WHERE id = $1', [id]);
    return res.rows[0];
  },

  async getDuePendingNotifications() {
    const res = await pool.query(
      "SELECT * FROM notifications WHERE status = 'PENDING' AND (scheduled_for IS NULL OR scheduled_for <= CURRENT_TIMESTAMP) ORDER BY created_at ASC"
    );
    return res.rows;
  },

  async searchNotifications(filters) {
    const { status, channel, provider, recipient, startDate, endDate } = filters;
    const page = parseInt(filters.page || 1, 10);
    const limit = parseInt(filters.limit || 10, 10);
    const offset = (page - 1) * limit;

    const whereClauses = [];
    const values = [];
    let paramIndex = 1;

    if (status) {
      whereClauses.push(`status = $${paramIndex}`);
      values.push(status);
      paramIndex++;
    }
    if (channel) {
      whereClauses.push(`channel = $${paramIndex}`);
      values.push(channel);
      paramIndex++;
    }
    if (provider) {
      whereClauses.push(`provider = $${paramIndex}`);
      values.push(provider);
      paramIndex++;
    }
    if (recipient) {
      whereClauses.push(`recipient = $${paramIndex}`);
      values.push(recipient);
      paramIndex++;
    }
    if (startDate) {
      whereClauses.push(`created_at >= $${paramIndex}`);
      values.push(new Date(startDate));
      paramIndex++;
    }
    if (endDate) {
      whereClauses.push(`created_at <= $${paramIndex}`);
      values.push(new Date(endDate));
      paramIndex++;
    }

    const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*) FROM notifications ${whereString}`, values);
    const total = parseInt(countRes.rows[0].count, 10);

    const query = `
      SELECT * FROM notifications 
      ${whereString} 
      ORDER BY created_at DESC 
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    
    const res = await pool.query(query, [...values, limit, offset]);

    return {
      notifications: res.rows,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  },

  async getStats() {
    const res = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'SENT' THEN 1 END) as sent,
        COUNT(CASE WHEN status = 'FAILED' THEN 1 END) as failed,
        COUNT(CASE WHEN status = 'PENDING' THEN 1 END) as pending,
        COUNT(CASE WHEN channel = 'EMAIL' THEN 1 END) as emails,
        COUNT(CASE WHEN channel = 'SMS' THEN 1 END) as sms
      FROM notifications
    `);
    const stats = res.rows[0];
    const total = parseInt(stats.total || 0, 10);
    const sent = parseInt(stats.sent || 0, 10);
    const successRate = total > 0 ? Math.round((sent / total) * 10000) / 100 : 100.00;

    return {
      total,
      sent,
      failed: parseInt(stats.failed || 0, 10),
      pending: parseInt(stats.pending || 0, 10),
      emails: parseInt(stats.emails || 0, 10),
      sms: parseInt(stats.sms || 0, 10),
      successRate,
      generatedAt: new Date().toISOString()
    };
  },

  async getAnalytics() {
    const dailyRes = await pool.query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM notifications
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at) ASC
    `);

    const channelRes = await pool.query(`
      SELECT channel, COUNT(*) as count
      FROM notifications
      GROUP BY channel
    `);

    const topRecipientsRes = await pool.query(`
      SELECT recipient, COUNT(*) as count
      FROM notifications
      GROUP BY recipient
      ORDER BY count DESC
      LIMIT 5
    `);

    const statsRes = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'SENT' THEN 1 END) as sent,
        COUNT(CASE WHEN status = 'FAILED' THEN 1 END) as failed
      FROM notifications
    `);

    const total = parseInt(statsRes.rows[0].total || 0, 10);
    const sent = parseInt(statsRes.rows[0].sent || 0, 10);
    const failed = parseInt(statsRes.rows[0].failed || 0, 10);

    const successRate = total > 0 ? Math.round((sent / total) * 10000) / 100 : 100.00;
    const failureRate = total > 0 ? Math.round((failed / total) * 10000) / 100 : 0.00;

    return {
      dailyVolume: dailyRes.rows.map(r => ({ date: r.date.toISOString().split('T')[0], count: parseInt(r.count, 10) })),
      channelBreakdown: channelRes.rows.map(r => ({ channel: r.channel, count: parseInt(r.count, 10) })),
      successRate,
      failureRate,
      topRecipients: topRecipientsRes.rows.map(r => ({ recipient: r.recipient, count: parseInt(r.count, 10) })),
      generatedAt: new Date().toISOString()
    };
  },

  async moveToDLQ(data) {
    const res = await pool.query(
      `INSERT INTO notification_dead_letter_queue (notification_id, reason, payload)
       VALUES ($1, $2, $3) RETURNING *`,
      [data.notificationId, data.reason, JSON.stringify(data.payload)]
    );
    return res.rows[0];
  },

  async getDLQEvents(limit = 50, offset = 0) {
    const res = await pool.query(
      `SELECT * FROM notification_dead_letter_queue ORDER BY failed_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return res.rows;
  },

  async getDLQDepth() {
    const res = await pool.query('SELECT COUNT(*) FROM notification_dead_letter_queue');
    return parseInt(res.rows[0].count, 10);
  },

  async getPreferences(userId) {
    const res = await pool.query('SELECT * FROM notification_preferences WHERE user_id = $1', [userId]);
    return res.rows[0];
  },

  // Templates CRUD layer
  async getTemplates() {
    const res = await pool.query('SELECT * FROM notification_templates ORDER BY name ASC');
    return res.rows;
  },

  async getTemplateById(id) {
    const res = await pool.query('SELECT * FROM notification_templates WHERE id = $1', [id]);
    return res.rows[0];
  },

  async getTemplateByName(name) {
    const res = await pool.query('SELECT * FROM notification_templates WHERE name = $1', [name]);
    return res.rows[0];
  },

  async createTemplate(data) {
    const res = await pool.query(
      `INSERT INTO notification_templates (name, channel, subject_template, body_template)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [data.name, data.channel, data.subjectTemplate || null, data.bodyTemplate]
    );
    return res.rows[0];
  },

  async updateTemplate(id, data) {
    const res = await pool.query(
      `UPDATE notification_templates 
       SET name = $1, channel = $2, subject_template = $3, body_template = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 RETURNING *`,
      [data.name, data.channel, data.subjectTemplate || null, data.bodyTemplate, id]
    );
    return res.rows[0];
  },

  async deleteTemplate(id) {
    const res = await pool.query('DELETE FROM notification_templates WHERE id = $1 RETURNING *', [id]);
    return res.rows[0];
  },

  getPool() {
    return pool;
  }
};

module.exports = NotificationModel;
