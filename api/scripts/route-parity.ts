/**
 * CI gate (TP §4 stage 5): every implemented HTTP route must appear in openapi.yaml, and vice
 * versa. Boots the Nest app, walks the Express router, and diffs against the spec's paths.
 * Exits non-zero on any drift.
 */
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';

function specPaths(): Set<string> {
  const yaml = readFileSync(join(__dirname, '..', 'openapi.yaml'), 'utf8');
  const set = new Set<string>();
  let inPaths = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^paths:/.test(line)) { inPaths = true; continue; }
    if (inPaths && /^\S/.test(line)) break; // left the paths block
    const m = line.match(/^ {2}(\/\S*):\s*$/);
    if (m) set.add(normalize(m[1]));
  }
  return set;
}

function normalize(p: string): string {
  return p.replace(/\{[^}]+\}/g, ':param').replace(/:[^/]+/g, ':param').replace(/\/$/, '') || '/';
}

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  const server = app.getHttpAdapter().getInstance();
  const stack = server._router?.stack ?? [];
  const routes = new Set<string>();
  for (const layer of stack) {
    if (layer.route) {
      routes.add(normalize(layer.route.path));
    }
  }
  await app.close();

  const spec = specPaths();
  const impl = routes;

  const missingInSpec = [...impl].filter((r) => !spec.has(r) && r !== '/');
  const missingInImpl = [...spec].filter((r) => !impl.has(r) && r !== '/');

  if (missingInSpec.length || missingInImpl.length) {
    if (missingInSpec.length)
      console.error('Routes implemented but NOT in openapi.yaml:\n  ' + missingInSpec.join('\n  '));
    if (missingInImpl.length)
      console.error('Paths in openapi.yaml but NOT implemented:\n  ' + missingInImpl.join('\n  '));
    process.exit(1);
  }
  console.log(`OpenAPI parity OK — ${impl.size} routes matched.`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
