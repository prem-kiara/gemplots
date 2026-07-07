import { Controller, Get } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { RedisService } from '../../common/redis/redis.service';
import { Public } from '../auth/decorators';

@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get()
  async health() {
    const db = await this.db
      .query('SELECT 1')
      .then(() => true)
      .catch(() => false);
    const redis = await this.redis.ping();
    return { status: db ? 'ok' : 'degraded', db, redis };
  }
}
