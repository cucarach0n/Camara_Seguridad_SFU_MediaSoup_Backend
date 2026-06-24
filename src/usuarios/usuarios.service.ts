import { Injectable, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { IsString, IsNotEmpty, MinLength, IsEnum, IsOptional } from 'class-validator';
import { Usuario } from './entities/usuario.entity';

export class CreateUsuarioDto {
  @IsString() @IsNotEmpty() username: string;
  @IsString() @MinLength(6) password: string;
  @IsEnum(['ADMIN', 'USER']) @IsOptional() rol?: 'ADMIN' | 'USER';
}

@Injectable()
export class UsuariosService {
  constructor(
    @InjectRepository(Usuario)
    private repo: Repository<Usuario>,
  ) {}

  async crear(dto: CreateUsuarioDto): Promise<Omit<Usuario, 'password_hash'>> {
    const exists = await this.repo.findOne({ where: { username: dto.username } });
    if (exists) throw new ConflictException(`El usuario '${dto.username}' ya existe`);

    const password_hash = await bcrypt.hash(dto.password, 10);
    const user = this.repo.create({
      username: dto.username,
      password_hash,
      rol: dto.rol ?? 'USER',
      activo: 1,
    });
    const saved = await this.repo.save(user);
    // No devolvemos el hash
    const { password_hash: _, ...result } = saved;
    return result;
  }

  async listar(): Promise<Omit<Usuario, 'password_hash'>[]> {
    const users = await this.repo.find({ order: { creado_en: 'DESC' } });
    return users.map(({ password_hash: _, ...u }) => u);
  }

  async findByUsername(username: string): Promise<Usuario | null> {
    return this.repo.findOne({ where: { username } });
  }

  async findById(id: number): Promise<Usuario | null> {
    return this.repo.findOne({ where: { id } });
  }
}
