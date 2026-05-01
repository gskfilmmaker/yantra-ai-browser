'use strict'

// Audit log worker — writes sensitive action records to the DB / S3
// In production this would be a separate process reading from a Redis queue

async function logAuditEvent({ userId, agentId, action, details, risk, sessionId, ts }) {
  const event = {
    userId, agentId, action, details, risk,
    sessionId, ts: ts || new Date().toISOString(),
  }
  // TODO: INSERT INTO audit_log (...) VALUES (...)
  // TODO: Also stream to S3 if AUDIT_S3_BUCKET is set
  console.log('[AUDIT]', JSON.stringify(event))
  return event
}

module.exports = { logAuditEvent }
