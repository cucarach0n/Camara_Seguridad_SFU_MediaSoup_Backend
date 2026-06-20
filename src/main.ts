import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as dotenv from 'dotenv';
import { join } from 'path';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({ origin: '*' });

  app.useStaticAssets(join(__dirname, '..', 'recordings'), {
    prefix: '/recordings/',
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Backend Mediasoup is running on port ${port}`);
}
bootstrap();
