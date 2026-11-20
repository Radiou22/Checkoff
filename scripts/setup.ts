import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const keys = ['ADMIN_PASSWORD', 'POSTGRES_PASSWORD', 'JWT_SECRET', 'INTERNAL_TOKEN'];
const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const config = template.replace(/^([A-Z_]+)=$/gm, (line, key: string) => {
  return keys.includes(key) ? key + '=' + randomBytes(32).toString('hex') : line;
});

try {
  await writeFile(new URL('../.env', import.meta.url), config, { flag: 'wx', mode: 0o600 });
  console.log(
    'Fichier .env créé. Les identifiants de caisse sont dans ADMIN_USERNAME et ADMIN_PASSWORD.',
  );
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  console.log('Le fichier .env est déjà présent.');
}
