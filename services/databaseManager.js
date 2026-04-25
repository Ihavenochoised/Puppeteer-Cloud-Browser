import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===== INITIALISATION =====
const secretsPath = path.join(__dirname, '../secrets');
if (!fs.existsSync(secretsPath)) {
    fs.mkdirSync(secretsPath);
    console.log('✅ Created secrets folder');
}
const usersPath = path.join(__dirname, '../secrets/users.json');
if (!fs.existsSync(usersPath) || fs.statSync(usersPath).size === 0) {
    fs.writeFileSync(usersPath, JSON.stringify({}));
    console.log('✅ Created users.json');
}

let users = JSON.parse(fs.readFileSync(usersPath));
let userCount = Object.keys(users).length;

// ===== PASSWORD HASHING =====
// scrypt is built-in, memory-hard, and the recommended choice when no extra
// dependency is allowed. Per-user random salt prevents rainbow-table attacks.
const SCRYPT_KEYLEN = 64;
const SALT_BYTES    = 16;

function hashPassword(password) {
    const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
    return { salt, hash };
}

function verifyPassword(password, salt, expectedHashHex) {
    const expected = Buffer.from(expectedHashHex, 'hex');
    const actual   = crypto.scryptSync(password, salt, expected.length);
    // Length check is required before timingSafeEqual — it throws on mismatched lengths.
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function saveUsers() {
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 4));
    userCount = Object.keys(users).length;
}

// ===== DATABASE MANAGER =====
function addUser(user, password) {
    if (users[user]) throw new Error(`User '${user}' already exists`);
    users[user] = hashPassword(password);
    saveUsers();
    console.log(`✅ Added user ${user}`);
}

function removeUser(user) {
    if (!users[user]) throw new Error(`User '${user}' does not exist`);
    delete users[user];
    saveUsers();
    // Delete ../userData/${user} folder
    const userDataPath = path.join(__dirname, `../userData/${user}`);
    if (fs.existsSync(userDataPath))
        fs.rmSync(userDataPath, { recursive: true, force: true });
    console.log(`✅ Removed user ${user} and deleted user data`);
}

function checkPassword(user, password) {
    // Return false on missing user instead of throwing — avoids leaking
    // existence via error shape and simplifies callers.
    const record = users[user];
    if (!record || !record.salt || !record.hash) return false;
    const ok = verifyPassword(password, record.salt, record.hash);
    console.log(`✅ Checked password for user ${user}: ${ok ? 'ok' : 'mismatch'}`);
    return ok;
}

function checkUser(user) {
    return users[user] !== undefined;
}

function getUserCount() {
    return userCount;
}

export { addUser, removeUser, checkPassword, checkUser, getUserCount };

// Data format (prettified)
/*
{
    "username": {
        "salt": "<hex>",
        "hash": "<hex scrypt(password, salt, 64)>"
    }
}
*/
