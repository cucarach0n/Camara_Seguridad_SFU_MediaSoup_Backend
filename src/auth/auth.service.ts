import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { Usuario } from '../usuarios/entities/usuario.entity';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(Usuario)
    private usuariosRepo: Repository<Usuario>,
    private jwtService: JwtService,
  ) {}

  async validateUser(username: string, password: string): Promise<Usuario> {
    const user = await this.usuariosRepo.findOne({ where: { username, activo: 1 } });
    if (!user) throw new UnauthorizedException('Credenciales inválidas');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new UnauthorizedException('Credenciales inválidas');

    return user;
  }

  async login(user: Usuario) {
    const payload = { sub: user.id, username: user.username, rol: user.rol };
    return {
      access_token: this.jwtService.sign(payload),
      rol: user.rol,
      username: user.username,
      id: user.id,
    };
  }

  async getMe(userId: number) {
    const user = await this.usuariosRepo.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Usuario no encontrado');
    return { id: user.id, username: user.username, rol: user.rol };
  }
}
