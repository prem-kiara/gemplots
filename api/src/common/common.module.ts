import { Global, Module } from '@nestjs/common';
import { DbService } from './db/db.service';
import { ConfigService } from './config/config.service';
import { RedisService } from './redis/redis.service';
import { AuditService } from './audit/audit.service';
import { S3Service } from './storage/s3.service';
import { EmailService } from './email/email.service';
import { ConsoleDriver } from './email/console.driver';
import { SmtpDriver } from './email/smtp.driver';

/** Shared infrastructure available to every module (01-arch §3). */
@Global()
@Module({
  providers: [
    DbService,
    ConfigService,
    RedisService,
    AuditService,
    S3Service,
    EmailService,
    ConsoleDriver,
    SmtpDriver,
  ],
  exports: [DbService, ConfigService, RedisService, AuditService, S3Service, EmailService],
})
export class CommonModule {}
