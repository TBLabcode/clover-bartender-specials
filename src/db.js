// Very simple file-based storage. No database to install or manage —
// everything just lives in data/db.json. Good enough for the volume
// of requests one bar generates in a day.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    return {
      pendingRequests: [],
      activeSpecials: [],
      bartenders: [],
      sessions: [],
      owners: [],
      ownerSessions: [],
    };
  }
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  const data = JSON.parse(raw);
  if (!data.bartenders) data.bartenders = [];
  if (!data.sessions) data.sessions = [];
  if (!data.owners) data.owners = [];
  if (!data.ownerSessions) data.ownerSessions = [];
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
  return readDb().bartenders.find((b) => b.phone === phone) || null;
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
  return readDb().owners.find((o) => o.phone === phone) || null;
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

module.exports = {
  addPendingRequest,
  getPendingRequests,
  removePendingRequest,
  addActiveSpecial,
  getActiveSpecials,
  clearActiveSpecials,
  addBartender,
  getBartenders,
  findBartenderByPhone,
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
};
