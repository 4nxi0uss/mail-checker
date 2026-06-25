const { exec } = require('child_process');
const fs = require('fs');
const nodemailer = require('nodemailer');
require('dotenv').config();

/**
 * Health Check Script
 *
 * Standalone health checker that verifies the monitor system is healthy.
 * Checks: cron process, heartbeat recency, consecutive errors, email system.
 * Sends email alert when status changes to unhealthy.
 */

// Load configuration
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_SUBJECT = process.env.EMAIL_SUBJECT || 'Cron Curl Monitor: Failures Detected';
const LOG_FILE = process.env.LOG_FILE || '/var/log/curl_monitor.log';
const HEARTBEAT_FILE = '/tmp/monitor_heartbeat.json';
const MAX_CONSECUTIVE_ERRORS = parseInt(process.env.MAX_CONSECUTIVE_ERRORS || '5', 10);
const HEARTBEAT_TIMEOUT_MS = parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '120000', 10); // 2 minutes

/**
 * Append a timestamped log line to the log file.
 */
function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [healthcheck] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    process.stderr.write(`Failed to write to log file ${LOG_FILE}: ${err.message}\n`);
    process.stderr.write(line);
  }
}

/**
 * Check if a process is running by name.
 */
function checkProcess(processName) {
  return new Promise((resolve) => {
    exec(`pgrep -x ${processName}`, (error) => {
      resolve(!error);
    });
  });
}

/**
 * Check if a binary is available and working.
 */
function checkBinary(binary) {
  return new Promise((resolve) => {
    exec(`which ${binary}`, (error) => {
      resolve(!error);
    });
  });
}

/**
 * Read the heartbeat file and return its data.
 */
function readHeartbeat() {
  try {
    if (!fs.existsSync(HEARTBEAT_FILE)) {
      return null;
    }
    const data = fs.readFileSync(HEARTBEAT_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    log(`Failed to read heartbeat file: ${err.message}`);
    return null;
  }
}

/**
 * Send email alert via SMTP.
 */
async function sendEmail(reason, details) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  const body = `Health check FAILED:\n\nReason: ${reason}\n\nDetails:\n${details}\n\nTime: ${new Date().toISOString()}\n`;

  const mailOptions = {
    from: SMTP_USER,
    to: EMAIL_TO,
    subject: `${EMAIL_SUBJECT} [HEALTH CHECK]`,
    text: body,
  };

  try {
    await transporter.sendMail(mailOptions);
    log(`Health check alert email sent successfully to ${EMAIL_TO}`);
  } catch (err) {
    log(`Failed to send health check alert email: ${err.message}`);
    process.stderr.write(`Failed to send health check alert email: ${err.message}\n`);
  }
}

/**
 * Read the last health status to avoid spamming emails.
 */
function readLastHealthStatus() {
  try {
    const statusFile = '/tmp/last_health_status.json';
    if (!fs.existsSync(statusFile)) {
      return null;
    }
    const data = fs.readFileSync(statusFile, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return null;
  }
}

/**
 * Write the current health status.
 */
function writeHealthStatus(status, reason) {
  try {
    const statusFile = '/tmp/last_health_status.json';
    const data = {
      status: status,
      reason: reason,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(statusFile, JSON.stringify(data, null, 2));
  } catch (err) {
    log(`Failed to write health status file: ${err.message}`);
  }
}

/**
 * Main health check logic.
 */
async function main() {
  const issues = [];

  // 1. Check if cron is running
  const cronRunning = await checkProcess('cron');
  if (!cronRunning) {
    issues.push('Cron process is not running');
  }

  // 2. Check if node binary is available
  const nodeAvailable = await checkBinary('node');
  if (!nodeAvailable) {
    issues.push('Node.js binary is not available');
  }

  // 3. Check if curl binary is available
  const curlAvailable = await checkBinary('curl');
  if (!curlAvailable) {
    issues.push('curl binary is not available');
  }

  // 4. Check heartbeat file
  const heartbeat = readHeartbeat();
  if (!heartbeat) {
    issues.push('Heartbeat file is missing - monitor may not have run yet');
  } else {
    const lastRun = new Date(heartbeat.last_run);
    const now = new Date();
    const timeSinceLastRun = now - lastRun;

    if (timeSinceLastRun > HEARTBEAT_TIMEOUT_MS) {
      issues.push(`Monitor has not run for ${Math.round(timeSinceLastRun / 1000)}s (timeout: ${HEARTBEAT_TIMEOUT_MS / 1000}s)`);
    }

    if (heartbeat.consecutive_errors > MAX_CONSECUTIVE_ERRORS) {
      issues.push(`Too many consecutive errors: ${heartbeat.consecutive_errors} (max: ${MAX_CONSECUTIVE_ERRORS})`);
    }

    if (heartbeat.last_email_status === 'failed') {
      issues.push('Last email send attempt failed');
    }
  }

  // 5. Check if log file is writable
  try {
    const logDir = require('path').dirname(LOG_FILE);
    fs.accessSync(logDir, fs.constants.W_OK);
  } catch (err) {
    issues.push(`Log directory is not writable: ${err.message}`);
  }

  const lastStatus = readLastHealthStatus();
  const isHealthy = issues.length === 0;

  if (isHealthy) {
    log('Health check passed');
    // If we were unhealthy before, log recovery
    if (lastStatus && lastStatus.status === 'unhealthy') {
      log('System recovered from unhealthy state');
    }
    writeHealthStatus('healthy', 'All checks passed');
    process.exit(0);
  } else {
    const reason = issues.join('; ');
    log(`Health check FAILED: ${reason}`);

    // Only send email if status changed from healthy to unhealthy
    if (!lastStatus || lastStatus.status === 'healthy') {
      log('Status changed to unhealthy, sending alert email');
      await sendEmail(reason, issues.map(i => `- ${i}`).join('\n'));
    } else {
      log('Still unhealthy, suppressing duplicate alert email');
    }

    writeHealthStatus('unhealthy', reason);
    process.exit(1);
  }
}

main().catch((err) => {
  log(`Unhandled error in healthcheck: ${err.message}`);
  process.stderr.write(`Unhandled error in healthcheck: ${err.message}\n`);
  process.exit(1);
});
