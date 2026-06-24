import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { UsuariosService, CreateUsuarioDto } from './usuarios.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('usuarios')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class UsuariosController {
  constructor(private service: UsuariosService) {}

  @Post()
  crear(@Body() dto: CreateUsuarioDto) {
    return this.service.crear(dto);
  }

  @Get()
  listar() {
    return this.service.listar();
  }
}
