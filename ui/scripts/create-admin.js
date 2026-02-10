import { createUser, findUserByUsername } from "../auth/auth.service.js";

const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) {
  console.error("Usage: node scripts/create-admin.js <username> <password>");
  process.exit(1);
}

const existing = findUserByUsername(username);
if (existing) {
  console.error("User already exists:", existing.username);
  process.exit(1);
}

const user = createUser({ username, password, role: "admin" });
console.log("Created user:", user);
