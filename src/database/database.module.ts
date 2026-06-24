import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Usuario } from '../usuarios/entities/usuario.entity';
import { Gateway } from '../gateways-db/entities/gateway.entity';
import { Transmision } from '../transmisiones/entities/transmision.entity';
import { Grabacion } from '../grabaciones/entities/grabacion.entity';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'mysql',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 3306),
        username: config.get<string>('DB_USER', 'root'),
        password: config.get<string>('DB_PASS', ''),
        database: config.get<string>('DB_NAME', 'SCSSOPORGRAM'),
        entities: [Usuario, Gateway, Transmision, Grabacion],
        synchronize: false,   // La BD la gestiona el script SQL
        timezone: 'local',
      }),
    }),
  ],
})
export class DatabaseModule {}
