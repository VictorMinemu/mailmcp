import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const text = `# Local development. See docs/HOSTING.md for a public HTTPS deployment.\nMAILMCP_MODE=local\nMAILMCP_MASTER_KEY=${randomBytes(32).toString('hex')}\nMAILMCP_DATA_DIR=./data\nMAILMCP_WEB_PORT=3210\n# All public mail providers; private and reserved addresses stay blocked.\nMAILMCP_ALLOWED_HOSTS=*\n`;
try {
  writeFileSync('.env', text, { flag: 'wx', mode: 0o600 });
  process.stderr.write(
    'Created .env with a random encryption key and public mail providers enabled.\n',
  );
} catch (error) {
  if (error.code === 'EEXIST') {
    process.stderr.write('.env already exists; left unchanged.\n');
  } else throw error;
}
