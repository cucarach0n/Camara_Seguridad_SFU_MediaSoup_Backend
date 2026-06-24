import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GatewaysDbService } from './gateways-db.service';
import { GatewaysDbController } from './gateways-db.controller';
import { Gateway } from './entities/gateway.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Gateway])],
  providers: [GatewaysDbService],
  controllers: [GatewaysDbController],
  exports: [GatewaysDbService],
})
export class GatewaysDbModule {}
