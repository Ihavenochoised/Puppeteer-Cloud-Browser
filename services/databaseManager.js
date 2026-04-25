import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===== INITIALISATION =====
const secretsPath = path.join(__dirname, '../secrets');
if (!fs.existsSync(secretsPath)) {
    fs.mkdirSync(secretsPath);
    console.log('✅ Created secrets folder');
}
const usersPath = path.join(__dirname, '../secrets/users.json');
if (!fs.existsSync(usersPath) || fs.readFileSync(usersPath).length === 0) {
    fs.writeFileSync(usersPath, JSON.stringify({}));
    console.log('✅ Created users.json');
}

let users = JSON.parse(fs.readFileSync(usersPath));
let userCount = Object.keys(users).length;

// ===== DATABASE MANAGER =====
function addUser(user, passwordHash) {
    users[user] = { passwordHash };
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 4));
    userCount = Object.keys(users).length;
    console.log(`✅ Added user ${user}`);
}
function removeUser(user) {
    delete users[user];
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 4));
    userCount = Object.keys(users).length;
    console.log(`✅ Removed user ${user}`);
     // If the user doesn't exist, this will throw an error
     // This is intentional, as it should be caught by the caller
    // Delete ../userData/${user} folder
    const userDataPath = path.join(__dirname, `../userData/${user}`);
    if (fs.existsSync(userDataPath))
        fs.rmSync(userDataPath, { recursive: true, force: true });
    console.log(`✅ Deleted user data for ${user}`);
}
function checkPassword(user, password) {
    // Compute the password hash
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    console.log(`✅ Checked password for user ${user}`);
    return users[user].passwordHash === passwordHash;
     // If the user doesn't exist, this will throw an error
     // This is intentional, as it should be caught by the caller
}
function checkUser(user) {
    // If user exists return true, else false
    return users[user] !== undefined;
}
function getUserCount() {
    return userCount;
}

export { addUser, removeUser, checkPassword, checkUser, getUserCount };

// Data format (prettified)
/*
{
    "users": {
        "username": {
            "passwordHash"
        }
    }
}
*/
