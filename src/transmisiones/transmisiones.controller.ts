import {
  Controller, Post, Get, Delete, Patch,
  Body, Param, Request, UseGuards, ParseIntPipe
} from '@nestjs/common';
import { TransmisionesService, CreateTransmisionDto } from './transmisiones.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('transmisiones')
@UseGuards(JwtAuthGuard)
export class TransmisionesController {
  constructor(private service: TransmisionesService) {}

  @Post()
  registrar(@Body() dto: CreateTransmisionDto, @Request() req) {
    return this.service.registrar(dto, req.user.id);
  }

  @Get()
  listar(@Request() req) {
    return this.service.getList(req.user.id, req.user.rol);
  }

  @Patch(':id/grabacion')
  toggleGrabacion(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.service.toggleGrabacion(id, req.user.id, req.user.rol);
  }

  @Delete(':id')
  eliminar(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.service.eliminar(id, req.user.id, req.user.rol);
  }
}
