import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from './db.js';
import { addErrorHandlers } from './http.js';
import { articleService } from './services/article.js';
import { checkoutService } from './services/checkout.js';
import { paymentService } from './services/payment.js';
import { receiptService } from './services/receipt.js';
import { stockService } from './services/stock.js';
import { usersService } from './services/users.js';

const services = {
  article: articleService,
  stock: stockService,
  payment: paymentService,
  receipt: receiptService,
  users: usersService,
  checkout: checkoutService,
};

async function listen(app, host, port) {
  const server = createServer(app);
  server.requestTimeout = 30_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

export async function start(config) {
  const names = config.service === 'all' ? Object.keys(services) : [config.service];
  if (names.some(name => !Object.hasOwn(services, name))) throw new Error('Service Checkoff inconnu.');
  if (!config.internalToken || config.internalToken.length < 32) {
    throw new Error('CHECKOFF_INTERNAL_TOKEN doit contenir au moins 32 caractères.');
  }
  const databases = [];
  const servers = {};
  const urls = { ...config.serviceUrls };

  async function close() {
    await Promise.all(Object.values(servers).map(server => new Promise(resolve => server.close(resolve))));
    for (const db of databases) db.close();
  }

  try {
    for (const name of names) {
      const db = openDatabase(config.dataDir, name);
      databases.push(db);
      const app = await services[name](db, { ...config, serviceUrls: urls });
      addErrorHandlers(app);
      const server = await listen(app, config.host, name === 'checkout' || names.length === 1 ? config.port : 0);
      servers[name] = server;
      if (names.length > 1) urls[name] = 'http://127.0.0.1:' + server.address().port;
    }
  } catch (error) {
    await close();
    throw error;
  }

  return { servers, urls, close };
}

function readConfig(env, service) {
  const singleService = service !== 'all';
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT invalide.');
  const serviceUrls = {};
  if (service === 'checkout') {
    for (const name of Object.keys(services).filter(name => name !== 'checkout')) {
      const value = env[name.toUpperCase() + '_URL'];
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL de service invalide.');
      serviceUrls[name] = url.href;
    }
  }

  return {
    service,
    port,
    host: singleService ? env.HOST ?? '0.0.0.0' : '127.0.0.1',
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    internalToken: env.CHECKOFF_INTERNAL_TOKEN ?? (singleService ? undefined : randomBytes(32).toString('hex')),
    adminUsername: env.ADMIN_USERNAME,
    adminPassword: env.ADMIN_PASSWORD,
    storeName: env.STORE_NAME ?? 'Checkoff',
    storeAddress: env.STORE_ADDRESS,
    storeTaxId: env.STORE_TAX_ID,
    mailFrom: env.MAIL_FROM,
    smtpUrl: env.SMTP_URL,
    corsOrigin: env.CORS_ORIGIN,
    trustProxy: env.TRUST_PROXY === '1' ? 1 : false,
    serviceUrls,
  };
}

async function main() {
  const config = readConfig(process.env, process.argv[2] ?? 'all');
  const running = await start(config);
  for (const [name, server] of Object.entries(running.servers)) {
    const { address, port } = server.address();
    console.log(`${name} écoute sur ${address}:${port}`);
  }
  const shutdown = async () => { await running.close(); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
