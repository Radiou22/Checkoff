import 'reflect-metadata';

import type { DocumentType } from '@checkoff/contracts';
import { DomainError } from '@checkoff/contracts';
import {
  Database,
  fromEnvInt,
  instanceId,
  queueName,
  queueOptions,
  queuePrefix,
  readReceipt,
  readSale,
  renderReceipt,
  required,
} from '@checkoff/infra';
import type { RenderJob } from '@checkoff/infra';
import { Injectable, Logger, Module } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import nodemailer from 'nodemailer';

type ReadyJob = { id: string; generation: number };
type DeliveryTask = {
  generation: number;
  status: 'pending' | 'sent' | 'failed';
  saleId: string;
  type: DocumentType;
};

function smtpTransport() {
  const url = new URL(required('SMTP_URL'));
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:')
    throw new Error('SMTP_URL doit utiliser smtp ou smtps.');
  const secure = url.protocol === 'smtps:';
  return nodemailer.createTransport({
    host: url.hostname,
    port: Number(url.port || (secure ? 465 : 587)),
    secure,
    requireTLS: process.env.SMTP_REQUIRE_TLS === '1',
    auth: url.username
      ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) }
      : undefined,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

@Injectable()
class JobRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(JobRunner.name);
  private readonly mode = process.env.WORKER_MODE || 'both';
  private timer?: ReturnType<typeof setInterval>;
  private dispatch?: Promise<void>;
  private queue?: Queue<RenderJob>;
  private worker?: Worker<RenderJob>;
  private mailer?: ReturnType<typeof smtpTransport>;

  constructor(private readonly db: Database) {}

  onApplicationBootstrap(): void {
    if (!['both', 'dispatch', 'email'].includes(this.mode))
      throw new Error('WORKER_MODE invalide.');
    const redis = new URL(required('REDIS_URL'));
    if (!['redis:', 'rediss:'].includes(redis.protocol)) throw new Error('REDIS_URL invalide.');
    const connection = {
      host: redis.hostname,
      port: Number(redis.port || 6379),
      username: redis.username ? decodeURIComponent(redis.username) : undefined,
      password: redis.password ? decodeURIComponent(redis.password) : undefined,
      db: Number(redis.pathname.slice(1) || 0),
      tls: redis.protocol === 'rediss:' ? {} : undefined,
    };
    if (this.mode !== 'email') {
      this.queue = new Queue<RenderJob>(queueName, {
        prefix: queuePrefix,
        connection: { ...connection, maxRetriesPerRequest: 1, commandTimeout: 3_000 },
        defaultJobOptions: queueOptions,
      });
      this.queue.on('error', () => this.log.warn('Redis indisponible pour la publication.'));
      this.timer = setInterval(() => this.tick(), fromEnvInt('DISPATCH_INTERVAL_MS', 500));
      this.tick();
    }
    if (this.mode !== 'dispatch') {
      const from = required('MAIL_FROM');
      this.mailer = smtpTransport();
      this.worker = new Worker<RenderJob>(queueName, (job) => this.send(job, from), {
        prefix: queuePrefix,
        connection,
        concurrency: fromEnvInt('WORKER_CONCURRENCY', 2),
      });
      this.worker.on('error', () => this.log.warn('Redis ou la file BullMQ est indisponible.'));
    }
  }

  private tick(): void {
    if (this.dispatch || !this.queue) return;
    this.dispatch = this.publish(this.queue)
      .catch(() => this.log.warn('Publication différée des envois.'))
      .finally(() => {
        this.dispatch = undefined;
      });
  }

  private async publish(queue: Queue<RenderJob>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<ReadyJob>(
        `SELECT id, generation FROM deliveries WHERE status='pending' AND dispatch_after <= now()
         ORDER BY dispatch_after,id LIMIT 20 FOR UPDATE SKIP LOCKED`,
      );
      for (const { id, generation } of rows) {
        const job = await queue.add(
          'render-and-send',
          { deliveryId: id, generation },
          { jobId: `${id}-${generation}` },
        );
        if ((await job.getState()) === 'failed') {
          await tx.query(
            `UPDATE deliveries SET status='failed',
             last_error=coalesce(last_error,'Le traitement BullMQ a été interrompu.')
             WHERE id=$1`,
            [id],
          );
          continue;
        }
        await tx.query(
          "UPDATE deliveries SET dispatch_after=now()+interval '60 seconds' WHERE id=$1",
          [id],
        );
      }
    });
  }

  private async send(job: Job<RenderJob>, from: string): Promise<void> {
    const { deliveryId, generation } = job.data;
    const attempt = job.attemptsMade + 1;
    const result = await this.db.transaction(async (tx) => {
      const {
        rows: [task],
      } = await tx.query<DeliveryTask>(
        'SELECT generation,status,sale_id AS "saleId",type FROM deliveries WHERE id=$1 FOR UPDATE',
        [deliveryId],
      );
      if (!task || task.generation !== generation || task.status !== 'pending') return null;
      const lastAttempt = attempt >= (job.opts.attempts ?? 1);
      try {
        const sale = await readSale(tx, task.saleId);
        const {
          rows: [card],
        } = await tx.query<{ email: string }>(
          'SELECT email FROM loyalty_cards WHERE id=$1 FOR SHARE',
          [sale.loyaltyId],
        );
        if (!card)
          throw new DomainError(409, 'recipient_missing', 'La carte de fidélité a été retirée.');
        const pdf = await renderReceipt(await readReceipt(tx, sale, task.type));
        const subject = task.type === 'ticket' ? 'Votre ticket de caisse' : 'Votre facture';
        const info = await this.mailer?.sendMail({
          from,
          to: { name: '', address: card.email },
          subject,
          text: 'Votre document Checkoff est en pièce jointe.',
          messageId: `<${deliveryId}-${generation}@checkoff.local>`,
          attachments: [
            {
              filename: `${task.type}-${task.saleId}.pdf`,
              content: pdf,
              contentType: 'application/pdf',
            },
          ],
        });
        if (!info?.accepted.length) throw new Error('SMTP rejected the recipient.');
      } catch (error) {
        const missing = error instanceof DomainError && error.code === 'recipient_missing';
        const message =
          error instanceof DomainError
            ? error.message
            : 'Le serveur de messagerie a refusé ou interrompu l’envoi.';
        await tx.query(
          'UPDATE deliveries SET status=$2, attempts=$3, last_error=$4, worker_instance=$5 WHERE id=$1',
          [
            deliveryId,
            lastAttempt || missing ? 'failed' : 'pending',
            attempt,
            message,
            instanceId(),
          ],
        );
        return missing ? null : message;
      }
      await tx.query(
        "UPDATE deliveries SET status='sent', attempts=$2, sent_at=now(), last_error=null, worker_instance=$3 WHERE id=$1",
        [deliveryId, attempt, instanceId()],
      );
      return null;
    });
    if (result) throw new Error(result);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.dispatch;
    await this.worker?.close();
    await this.queue?.close();
    this.mailer?.close();
  }
}

@Module({ providers: [Database, JobRunner] })
class JobsModule {}

const app = await NestFactory.createApplicationContext(JobsModule);
app.enableShutdownHooks();
