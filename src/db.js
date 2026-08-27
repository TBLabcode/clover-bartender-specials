// Very simple file-based storage. No database to install or manage —
// everything just lives in data/db.json. Good enough for the volume
// of requests one bar generates in a day.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const SHIFT_TYPES = ['day', 'night', 'allDay'];

function emptySchedule() {
  const schedule = {};
  for (const day of DAYS) schedule[day] = { day: null, night: null, allDay: null };
  return schedule;
}

// Strips formatting and a leading "1" country code so "+19105551234",
// "9105551234", and "(910) 555-1234" all match the same person.
function normalizePhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    return {
      pendingRequests: [],
      activeSpecials: [],
      bartenders: [],
      sessions: [],
      owners: [],
      ownerSessions: [],
      schedule: emptySchedule(),
      coverageRequests: [],
      scheduleOverrides: {},
      nextCoverageRequestNumber: 0,
    };
  }
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  const data = JSON.parse(raw);
  if (!data.bartenders) data.bartenders = [];
  if (!data.sessions) data.sessions = [];
  if (!data.owners) data.owners = [];
  if (!data.ownerSessions) data.ownerSessions = [];
  if (!data.schedule) data.schedule = emptySchedule();
  if (!data.coverageRequests) data.coverageRequests = [];
  if (!data.scheduleOverrides) data.scheduleOverrides = {};
  if (!data.nextCoverageRequestNumber) data.nextCoverageRequestNumber = 0;
  return data;
}

function writeDb(data) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function addPendingRequest(request) {
  const data = readDb();
  data.pendingRequests.push(request);
  writeDb(data);
  return request;
}

function getPendingRequests() {
  return readDb().pendingRequests;
}

// Removes a pending request by id and returns it (or null if not found)
function removePendingRequest(id) {
  const data = readDb();
  const idx = data.pendingRequests.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const [removed] = data.pendingRequests.splice(idx, 1);
  writeDb(data);
  return removed;
}

function addActiveSpecial(special) {
  const data = readDb();
  data.activeSpecials.push(special);
  writeDb(data);
  return special;
}

function getActiveSpecials() {
  return readDb().activeSpecials;
}

function clearActiveSpecials() {
  const data = readDb();
  data.activeSpecials = [];
  writeDb(data);
}

function addBartender(bartender) {
  const data = readDb();
  data.bartenders.push(bartender);
  writeDb(data);
  return bartender;
}

function getBartenders() {
  return readDb().bartenders;
}

function findBartenderByPhone(phone) {
  const target = normalizePhone(phone);
  return readDb().bartenders.find((b) => normalizePhone(b.phone) === target) || null;
}

function setBartenderConsentVersion(id, version) {
  const data = readDb();
  const bartender = data.bartenders.find((b) => b.id === id);
  if (!bartender) return null;
  bartender.smsConsentVersion = version;
  bartender.consentAcceptedAt = Date.now();
  writeDb(data);
  return bartender;
}

function removeBartender(id) {
  const data = readDb();
  const idx = data.bartenders.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  const [removed] = data.bartenders.splice(idx, 1);
  // Any sessions belonging to this bartender are no longer valid.
  data.sessions = data.sessions.filter((s) => s.bartenderId !== id);
  writeDb(data);
  return removed;
}

function addSession(session) {
  const data = readDb();
  data.sessions.push(session);
  writeDb(data);
  return session;
}

function findSessionByToken(token) {
  return readDb().sessions.find((s) => s.token === token) || null;
}

function removeSession(token) {
  const data = readDb();
  data.sessions = data.sessions.filter((s) => s.token !== token);
  writeDb(data);
}

function addOwner(owner) {
  const data = readDb();
  data.owners.push(owner);
  writeDb(data);
  return owner;
}

function getOwners() {
  return readDb().owners;
}

function findOwnerByPhone(phone) {
  const target = normalizePhone(phone);
  return readDb().owners.find((o) => normalizePhone(o.phone) === target) || null;
}

function removeOwner(id) {
  const data = readDb();
  const idx = data.owners.findIndex((o) => o.id === id);
  if (idx === -1) return null;
  const [removed] = data.owners.splice(idx, 1);
  data.ownerSessions = data.ownerSessions.filter((s) => s.ownerId !== id);
  writeDb(data);
  return removed;
}

function addOwnerSession(session) {
  const data = readDb();
  data.ownerSessions.push(session);
  writeDb(data);
  return session;
}

function findOwnerSessionByToken(token) {
  return readDb().ownerSessions.find((s) => s.token === token) || null;
}

function removeOwnerSession(token) {
  const data = readDb();
  data.ownerSessions = data.ownerSessions.filter((s) => s.token !== token);
  writeDb(data);
}

// --- Weekly recurring schedule: one bartender (or none) per day/shift-type slot ---

function getSchedule() {
  return readDb().schedule;
}

function setScheduleSlot(day, shiftType, bartenderId) {
  const data = readDb();
  data.schedule[day][shiftType] = bartenderId || null;
  writeDb(data);
  return data.schedule;
}

// Every day/shift-type slot this bartender is currently assigned to.
function getBartenderShifts(bartenderId) {
  const schedule = getSchedule();
  const shifts = [];
  for (const day of DAYS) {
    for (const shiftType of SHIFT_TYPES) {
      if (schedule[day][shiftType] === bartenderId) shifts.push({ day, shiftType });
    }
  }
  return shifts;
}

// --- Shift-coverage requests: a bartender giving away one of their own
// scheduled shifts, another bartender claiming it, then an owner approving ---

// A short, easy-to-text code for a coverage request ("1", "2", "3"...)
// instead of a random hex string — texting "YES 1" on a phone keyboard is a
// lot less error-prone than "YES a1b2c3". Numbers are never reused, so an
// old text with a stale code can't accidentally match a newer request.
function nextCoverageRequestNumber() {
  const data = readDb();
  data.nextCoverageRequestNumber += 1;
  writeDb(data);
  return data.nextCoverageRequestNumber;
}

function addCoverageRequest(request) {
  const data = readDb();
  data.coverageRequests.push(request);
  writeDb(data);
  return request;
}

function getCoverageRequests() {
  return readDb().coverageRequests;
}

function findCoverageRequest(id) {
  return readDb().coverageRequests.find((r) => r.id === id) || null;
}

function updateCoverageRequest(id, updates) {
  const data = readDb();
  const request = data.coverageRequests.find((r) => r.id === id);
  if (!request) return null;
  Object.assign(request, updates);
  writeDb(data);
  return request;
}

function removeCoverageRequest(id) {
  const data = readDb();
  const idx = data.coverageRequests.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const [removed] = data.coverageRequests.splice(idx, 1);
  writeDb(data);
  return removed;
}

// --- Schedule overrides: a one-off swap for a specific calendar date, once
// an owner approves a coverage request, WITHOUT touching the recurring
// weekly schedule (that swap is only for this one occurrence — the regular
// person is still on the recurring roster for every other future week). ---

// date is a local yyyy-mm-dd key (see dateKeyOf() in server.js).
function setScheduleOverride(date, shiftType, bartenderId) {
  const data = readDb();
  if (!data.scheduleOverrides[date]) data.scheduleOverrides[date] = {};
  data.scheduleOverrides[date][shiftType] = bartenderId || null;
  writeDb(data);
  return data.scheduleOverrides;
}

function getScheduleOverrides() {
  return readDb().scheduleOverrides;
}

module.exports = {
  DAYS,
  SHIFT_TYPES,
  normalizePhone,
  addPendingRequest,
  getPendingRequests,
  removePendingRequest,
  addActiveSpecial,
  getActiveSpecials,
  clearActiveSpecials,
  addBartender,
  getBartenders,
  findBartenderByPhone,
  setBartenderConsentVersion,
  removeBartender,
  addSession,
  findSessionByToken,
  removeSession,
  addOwner,
  getOwners,
  findOwnerByPhone,
  removeOwner,
  addOwnerSession,
  findOwnerSessionByToken,
  removeOwnerSession,
  getSchedule,
  setScheduleSlot,
  getBartenderShifts,
  nextCoverageRequestNumber,
  addCoverageRequest,
  getCoverageRequests,
  findCoverageRequest,
  updateCoverageRequest,
  removeCoverageRequest,
  setScheduleOverride,
  getScheduleOverrides,
};
