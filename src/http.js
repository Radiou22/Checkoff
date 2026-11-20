import { timingSafeEqual } from 'node:crypto';
import express from 'express';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function appFor(service, internalToken) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ service, status: 'ok' }));

  if (internalToken) {
    const expected = Buffer.from(internalToken);
    app.use((req, _res, next) => {
      const actual = Buffer.from(req.get('x-checkoff-internal') ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new HttpError(401, 'internal_auth_required', 'Accès réservé aux services Checkoff.');
      }
      next();
    });
  }

  app.use(express.json({ limit: '512kb' }));
  return app;
}

export function addErrorHandlers(app) {
  app.use(() => {
    throw new HttpError(404, 'route_not_found', 'Route inconnue.');
  });
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') {
      error = new HttpError(400, 'invalid_json', 'Le corps JSON est invalide.');
    }
    if (error.type === 'entity.too.large') {
      error = new HttpError(413, 'payload_too_large', 'Le corps de la requête est trop volumineux.');
    }
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    console.error(error);
    return res.status(500).json({ error: { code: 'internal_error', message: 'Erreur interne.' } });
  });
}

export function serviceClient(url, token) {
  return async (path, { method = 'GET', body } = {}) => {
    let response;
    try {
      response = await fetch(new URL(path, url), {
        method,
        headers: { 'content-type': 'application/json', 'x-checkoff-internal': token },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(12_000),
      });
      if (response.ok && response.headers.get('content-type')?.includes('application/pdf')) {
        return Buffer.from(await response.arrayBuffer());
      }
      const data = await response.json();
      if (response.ok) return data;
      if (data.error?.code && data.error?.message) {
        throw new HttpError(response.status, data.error.code, data.error.message);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
    }
    throw new HttpError(503, 'service_unavailable', 'Un service interne est indisponible.');
  };
}

export function invalid(field) {
  throw new HttpError(400, 'invalid_input', `Valeur invalide pour ${field}.`);
}

export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('le corps JSON');
  return value;
}

export function string(value, field, { min = 1, max = 120 } = {}) {
  if (typeof value !== 'string') invalid(field);
  const clean = value.trim();
  if (clean.length < min || clean.length > max || /[\u0000-\u001f\u007f]/u.test(clean)) invalid(field);
  return clean;
}

export function integer(value, field, { min = 0, max = 1_000_000_000 } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(field);
  return value;
}

export function gencod(value) {
  if (typeof value !== 'string' || !/^[0-9]{8,14}$/.test(value)) invalid('gencod');
  return value;
}

export function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) {
    invalid('identifiant');
  }
  return value;
}
