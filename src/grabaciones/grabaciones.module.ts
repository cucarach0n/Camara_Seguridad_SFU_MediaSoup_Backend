import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GrabacionesService } from './grabaciones.service';
import { GrabacionesController } from './grabaciones.controller';
import { Grabacion } from './entities/grabacion.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Grabacion])],
  providers: [GrabacionesService],
  controllers: [GrabacionesController],
  exports: [GrabacionesService],
})
export class GrabacionesModule {}
