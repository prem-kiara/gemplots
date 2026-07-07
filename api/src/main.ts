import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';
import { startWorkers } from './worker';

/** Minimal .env loader (no dependency) — only sets keys not already in the environment. */
function loadDotEnv() {
  for (const path of [join(process.cwd(), '.env'), join(__dirname, '..', '.env')]) {
    try {
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
      }
      return;
    } catch {
      /* try next path */
    }
  }
}

async function bootstrap() {
  loadDotEnv();
  const mode = process.env.WORKER_MODE ?? 'api';
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // Raw body for the webhook route only (CF §5 needs the exact bytes for HMAC).
  app.use(
    json({
      verify: (req: any, _res, buf) => {
        if (req.url?.startsWith('/v1/webhooks/')) req.rawBody = Buffer.from(buf);
      },
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );

  if (mode === 'worker' || mode === 'all') {
    await startWorkers(app);
  }
  if (mode === 'api' || mode === 'all') {
    const port = Number(process.env.PORT ?? 3000);
    await app.listen(port);
    // eslint-disable-next-line no-console
    console.log(`api listening on :${port} (mode=${mode})`);
  }
}
bootstrap();
