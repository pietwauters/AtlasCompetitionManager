'use strict';
// Run from the project root: node scripts/reset_admin_pin.js
require('../db/migrator').migrate();
const User = require('../services/users');

const users = User.findAll();
const admin = users.find(u => u.role === 'admin');

if (!admin) {
  console.log('No admin user found. Run install.sh to bootstrap one.');
  process.exit(1);
}

const pin = User.resetPin(admin.id);
console.log('');
console.log('  ┌─────────────────────────────────────────┐');
console.log('  │        ADMIN PIN RESET — SAVE NOW       │');
console.log('  │                                         │');
console.log('  │  Username : ' + admin.username.padEnd(28) + '│');
console.log('  │  New PIN  : ' + pin.padEnd(28) + '│');
console.log('  │                                         │');
console.log('  │  You will be forced to change it on     │');
console.log('  │  first login.                           │');
console.log('  └─────────────────────────────────────────┘');
console.log('');
