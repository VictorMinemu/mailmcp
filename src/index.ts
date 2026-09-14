import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { readConfig } from './config.js';
import { Vault } from './vault.js';
import { Accounts } from './accounts.js';
import { Auth } from './auth.js';
import { Mail } from './mail.js';
import { Oidc } from './oidc.js';
import { createMcp } from './mcp.js';
import { createWeb } from './web.js';
import { publicError } from './errors.js';

try {
  const config = readConfig(),
    vault = new Vault(config.dataDir, config.key);
  const accounts = new Accounts(vault, config.allowedHosts),
    auth = new Auth();
  const services = {
    accounts,
    auth,
    mail: new Mail(accounts, config.allowedHosts),
    origin: config.origin,
  };
  const web = createWeb(config, services, config.mode === 'hosted' ? new Oidc(config) : undefined);
  await new Promise<void>((resolve, reject) => {
    web.once('error', reject);
    web.listen(config.port, config.bind, resolve);
  }).catch((error) => {
    vault.close();
    throw error;
  });
  const stdio =
    config.mode === 'local'
      ? serveStdio(() => createMcp(services, 'local-owner'), {
          onerror: () => {
            process.stderr.write('MCP transport error\n');
          },
        })
      : undefined;
  process.stderr.write(`MailMCP ${config.mode} ready: ${config.origin}\n`);
  let shuttingDown = false;
  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const force = setTimeout(() => {
      vault.close();
      process.exit(1);
    }, 10_000);
    force.unref();
    await stdio?.close();
    web.closeAllConnections();
    await new Promise<void>((resolve) => web.close(() => resolve()));
    vault.close();
    clearTimeout(force);
  };
  process.on('SIGINT', () => {
    void stop();
  });
  process.on('SIGTERM', () => {
    void stop();
  });
  if (stdio)
    process.stdin.on('end', () => {
      void stop();
    });
} catch (error) {
  process.stderr.write(`${publicError(error).message}\n`);
  process.exitCode = 1;
}
