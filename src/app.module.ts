import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

// Infraestructura existente
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MediasoupService } from './mediasoup/mediasoup.service';
import { SignalingGateway } from './signaling/signaling.gateway';
import { RecordingService } from './recording/recording.service';
import { DvrCleanerService } from './recording/dvr-cleaner.service';
import { GoogleDriveService } from './google-drive/google-drive.service';
import { DvrUploaderService } from './recording/dvr-uploader.service';

// Nueva capa: entidades TypeORM
import { Usuario } from './usuarios/entities/usuario.entity';
import { Gateway } from './gateways-db/entities/gateway.entity';
import { Transmision } from './transmisiones/entities/transmision.entity';
import { Grabacion } from './grabaciones/entities/grabacion.entity';

// Nueva capa: módulos de autenticación y gobernanza
import { AuthModule } from './auth/auth.module';
import { UsuariosModule } from './usuarios/usuarios.module';
import { TransmisionesModule } from './transmisiones/transmisiones.module';
import { GatewaysDbModule } from './gateways-db/gateways-db.module';
import { GrabacionesModule } from './grabaciones/grabaciones.module';
import { SeedService } from './seed/seed.service';

@Module({
  imports: [
    // Configuración global de variables de entorno
    ConfigModule.forRoot({ isGlobal: true }),

    // Scheduler para tareas DVR periódicas
    ScheduleModule.forRoot(),

    // Servir grabaciones estáticas en la ruta /videos
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'recordings'),
      serveRoot: '/videos',
    }),

    // Base de datos MySQL con TypeORM
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: process.env.DB_HOST || 'localhost',
      port: +(process.env.DB_PORT || 3306),
      username: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'SCSSOPORGRAM',
      entities: [Usuario, Gateway, Transmision, Grabacion],
      synchronize: false,
      timezone: 'local',
    }),

    // Repositorio del SeedService (necesita acceso a Usuario)
    TypeOrmModule.forFeature([Usuario]),

    // Módulos de auth y usuarios
    AuthModule,
    UsuariosModule,

    // Módulos de Phase 2
    TransmisionesModule,
    GatewaysDbModule,
    GrabacionesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    MediasoupService,
    RecordingService,
    SignalingGateway,
    DvrCleanerService,
    GoogleDriveService,
    DvrUploaderService,
    SeedService,      // ← crea el admin inicial al arrancar
  ],
})
export class AppModule {}
