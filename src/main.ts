import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as dotenv from 'dotenv';
import { join } from 'path';

dotenv.config();

// Forzar zona horaria local si está definida en .env o usar America/Lima por defecto
if (process.env.TZ) {
  process.env.TZ = process.env.TZ;
} else {
  process.env.TZ = 'America/Lima';
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  
  // Agregar prefijo global para todas las rutas del API (soluciona colisión con Frontend)
  app.setGlobalPrefix('api');
  
  app.enableCors({ origin: '*' });

  app.useStaticAssets(join(__dirname, '..', 'recordings'), {
    prefix: '/recordings/',
  });

  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Backend Mediasoup is running on port ${port}`);
}
bootstrap();
