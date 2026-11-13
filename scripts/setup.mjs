import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const content = `# Local development configuration. Do not commit this file.\nDATABASE_URL=postgresql://deploydeck:deploydeck_local@localhost:5432/deploydeck\nSESSION_SECRET=${randomBytes(32).toString('hex')}\nENCRYPTION_KEY=${randomBytes(32).toString('hex')}\nAPP_ORIGIN=http://localhost:3000\nBASE_DOMAIN=localhost\nPUBLIC_PORT=8080\n`;
try {
  await writeFile(new URL('../.env', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with independent keys. Keep it private and back up the encryption key.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env already exists and was left unchanged.');
  else throw error;
}
