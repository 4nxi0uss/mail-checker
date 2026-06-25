const { exec } = require("child_process");
const fs = require("fs");
const nodemailer = require("nodemailer");
require("dotenv").config();

/**
 * Curl Monitor Script
 *
 * Runs a configurable list of curl commands, collects any non-200 HTTP responses,
 * and emails a summary if errors exist.
 */

// Load configuration from environment variables
const CURL_COMMANDS = JSON.parse(process.env.CURL_COMMANDS || "[]");
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_SUBJECT =
  process.env.EMAIL_SUBJECT || "Cron Curl Monitor: Failures Detected";
const LOG_FILE = process.env.LOG_FILE || "/var/log/curl_monitor.log";
const HEARTBEAT_FILE = "/tmp/monitor_heartbeat.json";
const MAX_CONSECUTIVE_ERRORS = parseInt(process.env.MAX_CONSECUTIVE_ERRORS || "5", 10);

/**
 * Append a timestamped log line to the log file.
 */
function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    // If we can't log to file, at least write to stderr
    process.stderr.write(
      `Failed to write to log file ${LOG_FILE}: ${err.message}\n`,
    );
    process.stderr.write(line);
  }
}

/**
 * Execute a single curl command and return its HTTP status code.
 */
function runCurl(command) {
  return new Promise((resolve) => {
    exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
      const statusCode = stdout.trim();

      resolve({
        statusCode: statusCode,
        error: error,
        stderr: stderr,
      });
    });
  });
}

/**
 * Read the current heartbeat data.
 */
function readHeartbeat() {
  try {
    if (!fs.existsSync(HEARTBEAT_FILE)) {
      return { consecutive_errors: 0, total_runs: 0, last_email_status: "unknown" };
    }
    const data = fs.readFileSync(HEARTBEAT_FILE, "utf8");
    return JSON.parse(data);
  } catch (err) {
    log(`Failed to read heartbeat file: ${err.message}`);
    return { consecutive_errors: 0, total_runs: 0, last_email_status: "unknown" };
  }
}

/**
 * Write heartbeat data to the heartbeat file.
 */
function writeHeartbeat(consecutiveErrors, totalRuns, lastEmailStatus) {
  try {
    const data = {
      last_run: new Date().toISOString(),
      consecutive_errors: consecutiveErrors,
      total_runs: totalRuns,
      last_email_status: lastEmailStatus,
    };
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log(`Failed to write heartbeat file: ${err.message}`);
  }
}

/**
 * Send email via SMTP using nodemailer.
 */
async function sendEmail(errors) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  let body = "The following curl checks failed:\n\n";

  for (const err of errors) {
    body += `- ID: ${err.id}\n`;
    body += `  Status Code: ${err.statusCode}\n`;
    body += `  Command: ${err.command}\n`;

    if (err.stderr) {
      body += `  Stderr: ${err.stderr}\n`;
    }

    body += "\n";
  }

  const mailOptions = {
    from: SMTP_USER,
    to: EMAIL_TO,
    subject: EMAIL_SUBJECT,
    text: body,
  };

  try {
    await transporter.sendMail(mailOptions);
    log(`Email sent successfully to ${EMAIL_TO}`);
    return "success";
  } catch (err) {
    log(`Failed to send email: ${err.message}`);
    process.stderr.write(`Failed to send email: ${err.message}\n`);
    return "failed";
  }
}

/**
 * Main execution logic.
 */
async function main() {
  log("Monitor started");

  // Read previous heartbeat state
  const heartbeat = readHeartbeat();
  let consecutiveErrors = heartbeat.consecutive_errors || 0;
  let totalRuns = (heartbeat.total_runs || 0) + 1;
  let lastEmailStatus = heartbeat.last_email_status || "unknown";

  if (CURL_COMMANDS.length === 0) {
    log("No curl commands configured. Exiting.");
    writeHeartbeat(consecutiveErrors, totalRuns, lastEmailStatus);
    return;
  }

  const errors = [];

  for (const item of CURL_COMMANDS) {
    const id = item.id;
    const command = item.command;

    log(`Running check: ${id}`);
    const result = await runCurl(command);

    if (result.statusCode === "200") {
      log(`Check ${id} succeeded (HTTP 200)`);
    } else {
      log(`Check ${id} failed (HTTP ${result.statusCode})`);
      errors.push({
        id: id,
        command: command,
        statusCode: result.statusCode,
        stderr: result.stderr ? result.stderr.trim() : "",
      });
    }
  }

  if (errors.length > 0) {
    consecutiveErrors++;
    log(`Monitor finished with ${errors.length} error(s). Consecutive error count: ${consecutiveErrors}`);
    lastEmailStatus = await sendEmail(errors);
  } else {
    log("Monitor finished. All checks passed.");
    consecutiveErrors = 0;
  }

  // Write heartbeat for health checker
  writeHeartbeat(consecutiveErrors, totalRuns, lastEmailStatus);
}

main().catch((err) => {
  log(`Unhandled error in monitor: ${err.message}`);
  process.stderr.write(`Unhandled error: ${err.message}\n`);
  process.exit(1);
});
