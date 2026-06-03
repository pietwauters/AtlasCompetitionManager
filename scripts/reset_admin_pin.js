'use strict';
// Run from the project root: node scripts/reset_admin_pin.js
require('../db/migrator').migrate();
const User = require('../services/users');

const users = User.findAll();
const admin = users.find(u => u.role === 'admin');

let pin;
let username;

if (!admin) {
  const result = User.create({ username: 'admin', role: 'admin' });
  pin      = result.plainPin;
  username = result.user.username;
  console.log('(No admin found — created a new one.)');
} else {
  pin      = User.resetPin(admin.id);
  username = admin.username;
}

console.log('');
console.log('  ┌─────────────────────────────────────────┐');
console.log('  │        ADMIN PIN RESET — SAVE NOW       │');
console.log('  │                                         │');
console.log('  │  Username : ' + username.padEnd(28) + '│');
console.log('  │  New PIN  : ' + pin.padEnd(28) + '│');
console.log('  │                                         │');
console.log('  │  You will be forced to change it on     │');
console.log('  │  first login.                           │');
console.log('  └─────────────────────────────────────────┘');
console.log('');
