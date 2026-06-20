import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: '*' });
  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Backend Mediasoup is running on port ${port}`);
}
bootstrap();
