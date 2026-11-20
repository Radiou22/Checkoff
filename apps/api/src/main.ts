import 'reflect-metadata';

import { DomainError } from '@checkoff/contracts';
import { Database, fromEnvInt, instanceId, required } from '@checkoff/infra';
import {
  Catch,
  Controller,
  Get,
  Header,
  HttpException,
  Logger,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter, NestMiddleware } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { cleanupOpenApiDoc, ZodValidationPipe } from 'nestjs-zod';

import { AuthGuard, AuthService, Public } from './auth.js';
import { CatalogService } from './catalog.js';
import {
  AuthController,
  CatalogController,
  LoyaltyController,
  SalesController,
  UsersController,
} from './controllers.js';
import { SharedRedis } from './redis.js';
import { SalesService } from './sales.js';

type Response = { status(code: number): Response; json(body: unknown): void };
const logger = new Logger('HTTP');

@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof DomainError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof HttpException) {
      const status = error.getStatus();
      response.status(status).json({
        error: {
          code:
            status === 400 ? 'invalid_input' : status === 404 ? 'route_not_found' : 'http_error',
          message: status === 400 ? 'Paramètres ou corps JSON invalides.' : error.message,
        },
      });
      return;
    }
    const code = error instanceof Error && 'code' in error ? error.code : null;
    if (code === '40P01' || code === '40001' || code === '55P03') {
      response.status(503).json({
        error: {
          code: 'retry_transaction',
          message: 'Conflit temporaire. Réessayez la requête.',
        },
      });
      return;
    }
    logger.error(error instanceof Error ? error.message : 'Unexpected request error');
    response.status(500).json({ error: { code: 'internal_error', message: 'Erreur interne.' } });
  }
}

@Public()
@Controller()
class OperationalController {
  constructor(
    private readonly db: Database,
    private readonly redis: SharedRedis,
  ) {}

  @Get('health')
  async health() {
    try {
      await Promise.all([
        this.db.pool.query('SELECT 1 FROM catalog_revision'),
        this.redis.client.ping(),
      ]);
    } catch {
      throw new ServiceUnavailableException('PostgreSQL ou Redis indisponible.');
    }
    return { status: 'ok', service: 'api', instance: instanceId() };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async metrics() {
    const {
      rows: [row],
    } = await this.db.pool.query<{ sales: string; pending: string; failed: string }>(
      `SELECT (SELECT count(*) FROM sales WHERE paid_at IS NOT NULL) AS sales,
       (SELECT count(*) FROM deliveries WHERE status='pending') AS pending,
       (SELECT count(*) FROM deliveries WHERE status='failed') AS failed`,
    );
    return (
      `# TYPE checkoff_sales_paid gauge\ncheckoff_sales_paid ${row?.sales ?? '0'}\n` +
      `# TYPE checkoff_deliveries_pending gauge\ncheckoff_deliveries_pending ${row?.pending ?? '0'}\n` +
      `# TYPE checkoff_deliveries_failed gauge\ncheckoff_deliveries_failed ${row?.failed ?? '0'}\n`
    );
  }
}

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: required('JWT_SECRET', 32),
        signOptions: { algorithm: 'HS256', issuer: 'checkoff-api', audience: 'checkoff-front' },
        verifyOptions: {
          algorithms: ['HS256'],
          issuer: 'checkoff-api',
          audience: 'checkoff-front',
        },
      }),
    }),
  ],
  controllers: [
    OperationalController,
    AuthController,
    UsersController,
    CatalogController,
    LoyaltyController,
    SalesController,
  ],
  providers: [
    Database,
    SharedRedis,
    CatalogService,
    AuthService,
    SalesService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
class ApiModule {}

async function main(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { bodyParser: false });
  app.useBodyParser('json', { limit: '512kb' });
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.useGlobalFilters(new Errors());
  app.useGlobalPipes(new ZodValidationPipe());
  app.use('/api', helmet());
  const decorateApi: NestMiddleware['use'] = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Checkoff-Instance', instanceId());
    next();
  };
  app.use('/api', decorateApi);

  const origin = process.env.CORS_ORIGIN;
  if (origin) app.enableCors({ origin, allowedHeaders: ['Authorization', 'Content-Type'] });
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Checkoff')
    .setDescription('API de caisse et suivi des justificatifs')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    'docs',
    app,
    () => cleanupOpenApiDoc(SwaggerModule.createDocument(app, swaggerConfig)),
    {
      jsonDocumentUrl: 'docs/openapi.json',
    },
  );
  app.enableShutdownHooks();
  await app.listen(fromEnvInt('PORT', 8080), '0.0.0.0');
}

await main();
