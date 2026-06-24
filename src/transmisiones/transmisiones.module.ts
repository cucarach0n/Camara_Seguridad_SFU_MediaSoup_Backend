import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransmisionesService } from './transmisiones.service';
import { TransmisionesController } from './transmisiones.controller';
import { Transmision } from './entities/transmision.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Transmision])],
  providers: [TransmisionesService],
  controllers: [TransmisionesController],
  exports: [TransmisionesService],
})
export class TransmisionesModule {}
