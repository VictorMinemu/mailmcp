import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const text = `# Local development. See docs/HOSTING.md for a public HTTPS deployment.\nMAILMCP_MODE=local\nMAILMCP_MASTER_KEY=${randomBytes(32).toString('hex')}\nMAILMCP_DATA_DIR=./data\nMAILMCP_WEB_PORT=3210\nMAILMCP_ALLOWED_HOSTS=imap.gmail.com,smtp.gmail.com,pop.gmail.com,outlook.office365.com,smtp.office365.com\n`;
try {
  writeFileSync('.env', text, { flag: 'wx', mode: 0o600 });
  process.stderr.write(
    'Created .env with a random encryption key. Edit allowed hosts for your mail providers.\n',
  );
} catch (error) {
  if (error.code === 'EEXIST') {
    process.stderr.write('.env already exists; left unchanged.\n');
  } else throw error;
}
