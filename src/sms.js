const twilio = require('twilio');

const DRY_RUN = process.env.TWILIO_DRY_RUN === 'true';

// Skip constructing the real client in dry-run mode — avoids validating
// Twilio credentials that may not be filled in yet.
const client = DRY_RUN ? null : twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const approverNumbers = (process.env.APPROVER_PHONE_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

// Send one text to a single number
async function sendText(toNumber, body) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would text ${toNumber}:\n${body}\n`);
    return { sid: 'DRY_RUN', to: toNumber, body };
  }

  return client.messages.create({
    to: toNumber,
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    body,
  });
}

// Send the same text to every approver (you + your business partner).
// Uses allSettled so one approver's bad number doesn't stop the other
// from getting notified; throws only if every send failed.
async function notifyApprovers(body) {
  const results = await Promise.allSettled(approverNumbers.map((num) => sendText(num, body)));

  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    failures.forEach((f) => console.error('Failed to text an approver:', f.reason.message));
  }
  if (failures.length === results.length && results.length > 0) {
    throw new Error(`Failed to notify any approver: ${failures[0].reason.message}`);
  }

  return results;
}

module.exports = {
  sendText,
  notifyApprovers,
  approverNumbers,
};
