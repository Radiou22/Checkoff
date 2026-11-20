import { required } from '@checkoff/infra';
import { Redis } from 'ioredis';

export class SharedRedis {
  readonly client = new Redis(required('REDIS_URL'), {
    maxRetriesPerRequest: 1,
    commandTimeout: 2_000,
  });

  onApplicationShutdown(): void {
    this.client.disconnect();
  }
}
