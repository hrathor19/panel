#!/usr/bin/env node
// Emergency access for when nobody can sign in to the admin UI. Day-to-day
// user management lives at /admin.
import { listUsers, addUser, updateUser, findUser } from '../src/users.js';
import { generatePassword } from '../src/routes/admin.js';

const args = process.argv.slice(2);

function usage() {
  console.log(`
Recovery commands. Normal user management is in the admin UI at /admin.

  npm run userlist                              list users
  npm run useradd -- <email> [name] [admin]     add a user
  npm run passwd  -- <email>                    set a new password
  npm run passwd  -- <email> --password=SECRET  set a specific password
  npm run useradd -- --promote <email>          make someone an admin
  npm run useradd -- --disable <email>          revoke access
  npm run useradd -- --enable  <email>          restore access
`);
}

async function requireUser(email) {
  const user = await findUser(email);
  if (!user) throw new Error(`no such user: ${email}`);
  return user;
}

try {
  if (args.length === 0 || args.includes('--help')) {
    usage();
    process.exit(0);
  }

  if (args.includes('--list')) {
    const users = await listUsers();
    if (users.length === 0) console.log('No users yet.');
    for (const u of users) {
      const panels = u.panels === '*' ? 'all panels' : `${(u.panels ?? []).length} panel(s)`;
      console.log(`${u.active ? ' ' : '✗'} ${u.email.padEnd(32)} ${u.role.padEnd(6)} ${panels}`);
    }
    process.exit(0);
  }

  const chosen = args.find((a) => a.startsWith('--password='))?.slice('--password='.length);

  const resetAt = args.indexOf('--reset');
  if (resetAt !== -1) {
    const user = await requireUser(args[resetAt + 1]);
    const password = chosen || generatePassword();
    await updateUser(user.id, { password });
    console.log(`\nPassword changed for ${user.email}.`);
    if (!chosen) console.log(`New password: ${password}`);
    console.log('Any session they had open has been signed out.\n');
    process.exit(0);
  }

  for (const [flag, patch, verb] of [
    ['--promote', { role: 'admin' }, 'is now an admin'],
    ['--disable', { active: false }, 'disabled'],
    ['--enable', { active: true }, 'enabled'],
  ]) {
    const at = args.indexOf(flag);
    if (at === -1) continue;
    const user = await requireUser(args[at + 1]);
    await updateUser(user.id, patch);
    console.log(`${user.email} ${verb}.`);
    process.exit(0);
  }

  const positional = args.filter((a) => !a.startsWith('--'));
  const [email, name, role] = positional;
  if (!email?.includes('@')) throw new Error('first argument must be an email address');

  const password = chosen || generatePassword();
  const user = await addUser({
    email,
    name,
    password,
    role: role === 'admin' ? 'admin' : 'user',
    panels: '*',
  });

  console.log(`\nAdded ${user.email} (${user.role}), access to all panels.`);
  if (!chosen) console.log(`Password: ${password}`);
  console.log(`Change it later with:  npm run passwd -- ${user.email}\n`);
} catch (err) {
  console.error(`\nError: ${err.message}\n`);
  process.exit(1);
}
