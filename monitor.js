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
  } catch (err) {
    log(`Failed to send email: ${err.message}`);
    process.stderr.write(`Failed to send email: ${err.message}\n`);
  }
}

/**
 * Main execution logic.
 */
async function main() {
  log("Monitor started");

  if (CURL_COMMANDS.length === 0) {
    log("No curl commands configured. Exiting.");
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
    log(`Monitor finished with ${errors.length} error(s). Sending email.`);
    await sendEmail(errors);
  } else {
    log("Monitor finished. All checks passed.");
  }
}

main().catch((err) => {
  log(`Unhandled error in monitor: ${err.message}`);
  process.stderr.write(`Unhandled error: ${err.message}\n`);
  process.exit(1);
});
