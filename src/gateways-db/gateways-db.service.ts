import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IsString, IsNotEmpty, IsNumber } from 'class-validator';
import { Gateway } from './entities/gateway.entity';

export class CreateGatewayDto {
  @IsString() @IsNotEmpty() identificador: string;
  @IsString() @IsNotEmpty() nombre: string;
  @IsNumber() user_id: number;
}

@Injectable()
export class GatewaysDbService {
  constructor(
    @InjectRepository(Gateway)
    private repo: Repository<Gateway>,
  ) {}

  async registrar(dto: CreateGatewayDto): Promise<Gateway> {
    const gw = this.repo.create(dto);
    return this.repo.save(gw);
  }

  async findByIdentificador(identificador: string): Promise<Gateway | null> {
    return this.repo.findOne({ where: { identificador }, relations: { usuario: true } });
  }

  async marcarConectado(id: number, conectado: number) {
    await this.repo.update(id, {
      conectado,
      ultimo_ping: conectado ? new Date() : undefined,
    });
  }

  async getMisGateways(userId: number, rol: string): Promise<Gateway[]> {
    const query = this.repo.createQueryBuilder('g')
      .leftJoinAndSelect('g.usuario', 'u')
      .orderBy('g.id', 'ASC');
    if (rol !== 'ADMIN') {
      query.where('g.user_id = :userId', { userId });
    }
    return query.getMany();
  }

  async eliminar(id: number, userId: number, rol: string) {
    const gw = await this.repo.findOne({ where: { id } });
    if (!gw) throw new NotFoundException(`Gateway ${id} no encontrado`);
    if (rol !== 'ADMIN' && gw.user_id !== userId) {
      throw new ForbiddenException('Sin permiso sobre este gateway');
    }
    await this.repo.delete(id);
  }
}
