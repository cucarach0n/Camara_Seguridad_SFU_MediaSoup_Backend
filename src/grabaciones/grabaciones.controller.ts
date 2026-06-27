import { Controller, Get, Delete, Param, Request, UseGuards, ParseIntPipe } from '@nestjs/common';
import { GrabacionesService } from './grabaciones.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('grabaciones')
@UseGuards(JwtAuthGuard)
export class GrabacionesController {
  constructor(private service: GrabacionesService) {}

  @Get()
  listar(@Request() req) {
    return this.service.getList(req.user.id, req.user.rol);
  }

  @Get(':id')
  obtenerUno(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.service.getById(id, req.user.id, req.user.rol);
  }

  @Delete(':id')
  async eliminar(@Param('id', ParseIntPipe) id: number, @Request() req) {
    await this.service.delete(id, req.user.id, req.user.rol);
    return { success: true, message: 'Grabación eliminada correctamente' };
  }
}
