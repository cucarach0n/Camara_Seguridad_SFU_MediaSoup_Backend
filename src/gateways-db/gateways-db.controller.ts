import { Controller, Post, Get, Delete, Param, Body, Request, UseGuards, ParseIntPipe } from '@nestjs/common';
import { GatewaysDbService, CreateGatewayDto } from './gateways-db.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('gateways')
@UseGuards(JwtAuthGuard)
export class GatewaysDbController {
  constructor(private service: GatewaysDbService) {}

  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @Post()
  registrar(@Body() dto: CreateGatewayDto) {
    return this.service.registrar(dto);
  }

  @Get()
  listar(@Request() req) {
    return this.service.getMisGateways(req.user.id, req.user.rol);
  }

  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @Delete(':id')
  eliminar(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.service.eliminar(id, req.user.id, req.user.rol);
  }
}
