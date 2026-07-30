// Very simple file-based storage. No database to install or manage —
// everything just lives in data/db.json. Good enough for the volume
// of requests one bar generates in a day.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    return { pendingRequests: [], activeSpecials: [] };
  }
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  return JSON.parse(raw);
}

function writeDb(data) {
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

module.exports = {
  addPendingRequest,
  getPendingRequests,
  removePendingRequest,
  addActiveSpecial,
  getActiveSpecials,
  clearActiveSpecials,
};
