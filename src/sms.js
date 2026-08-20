const twilio = require('twilio');
const db = require('./db');

const DRY_RUN = process.env.TWILIO_DRY_RUN === 'true';

// Skip constructing the real client in dry-run mode — avoids validating
// Twilio credentials that may not be filled in yet.
const client = DRY_RUN ? null : twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const approverNumbers = (process.env.APPROVER_PHONE_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

// Send one text to a single number. Defaults to the specials-approval
// Messaging Service/number; pass TWILIO_SHIFT_MESSAGING_SERVICE_SID to
// send from the separate shift-coverage number instead — these are two
// distinct A2P campaigns and each recipient must have opted into the
// one they're being sent from (see /sms-consent.html).
async function sendText(toNumber, body, messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would text ${toNumber}:\n${body}\n`);
    return { sid: 'DRY_RUN', to: toNumber, body };
  }

  return client.messages.create({
    to: toNumber,
    messagingServiceSid,
    body,
  });
}

// Send one text from the shift-coverage number (a separate A2P campaign
// from the specials-approval flow above — see TWILIO_SHIFT_MESSAGING_SERVICE_SID).
async function sendShiftText(toNumber, body) {
  return sendText(toNumber, body, process.env.TWILIO_SHIFT_MESSAGING_SERVICE_SID);
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

// Send the same text to every registered owner (db.getOwners()), not the
// fixed APPROVER_PHONE_NUMBERS list — used for alerts owners specifically
// need to see, like a failed revert. Owner phone numbers are stored as
// plain 10-digit US numbers, so E.164-format them here before sending.
async function notifyOwners(body) {
  const ownerNumbers = db.getOwners().map((o) => `+1${o.phone}`);
  const results = await Promise.allSettled(ownerNumbers.map((num) => sendText(num, body)));

  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    failures.forEach((f) => console.error('Failed to text an owner:', f.reason.message));
  }

  return results;
}

// Send a shift-coverage text (open shift, or a claim confirmation) to every
// registered bartender, from the shift-coverage number — not the specials-
// approval number notifyApprovers/notifyOwners use. Only bartenders who
// opted into shift-coverage texts (smsConsentVersion current) should be
// passed in once that gate exists on this flow's own callers.
async function notifyBartendersShift(body) {
  const bartenderNumbers = db.getBartenders().map((b) => `+1${b.phone}`);
  const results = await Promise.allSettled(bartenderNumbers.map((num) => sendShiftText(num, body)));

  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    failures.forEach((f) => console.error('Failed to text a bartender about a shift:', f.reason.message));
  }

  return results;
}

module.exports = {
  sendText,
  sendShiftText,
  notifyApprovers,
  notifyOwners,
  notifyBartendersShift,
  approverNumbers,
};
