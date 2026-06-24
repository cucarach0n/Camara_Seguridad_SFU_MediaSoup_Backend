import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IsString, IsNotEmpty, IsEnum, IsOptional, IsNumber } from 'class-validator';
import { Transmision } from './entities/transmision.entity';

export class CreateTransmisionDto {
  @IsEnum(['NAVEGADOR', 'RTSP']) tipo_origen: 'NAVEGADOR' | 'RTSP';
  @IsString() @IsNotEmpty() nombre: string;
  @IsString() @IsOptional() url_rtsp?: string;
  @IsNumber() @IsOptional() gateway_id?: number;
}

@Injectable()
export class TransmisionesService {
  constructor(
    @InjectRepository(Transmision)
    private repo: Repository<Transmision>,
  ) {}

  async registrar(dto: CreateTransmisionDto, userId: number): Promise<Transmision> {
    const t = this.repo.create({
      user_id: userId,
      tipo_origen: dto.tipo_origen,
      nombre: dto.nombre,
      url_rtsp: dto.url_rtsp ?? null,
      gateway_id: dto.gateway_id ?? null,
      activa: 0,
      grabacion_activa: 0,
    });
    return this.repo.save(t);
  }

  async getList(userId: number, rol: string): Promise<Transmision[]> {
    const query = this.repo.createQueryBuilder('t')
      .leftJoinAndSelect('t.usuario', 'u')
      .leftJoinAndSelect('t.gateway', 'g')
      .orderBy('t.creado_en', 'DESC');

    if (rol !== 'ADMIN') {
      query.where('t.user_id = :userId', { userId });
    }
    return query.getMany();
  }

  async findById(id: number): Promise<Transmision> {
    const t = await this.repo.findOne({ where: { id }, relations: { gateway: true } });
    if (!t) throw new NotFoundException(`Transmisión ${id} no encontrada`);
    return t;
  }

  async actualizarProductorId(id: number, producerId: string | null) {
    await this.repo.update(id, { productor_id: producerId });
  }

  async marcarActiva(id: number, activa: number) {
    await this.repo.update(id, { activa });
  }

  async toggleGrabacion(id: number, userId: number, rol: string): Promise<{ grabacion_activa: number }> {
    const t = await this.findById(id);
    if (rol !== 'ADMIN' && t.user_id !== userId) {
      throw new ForbiddenException('No tienes permiso sobre esta transmisión');
    }
    const nuevoEstado = t.grabacion_activa === 1 ? 0 : 1;
    await this.repo.update(id, { grabacion_activa: nuevoEstado });
    return { grabacion_activa: nuevoEstado };
  }

  async setGrabacion(id: number, userId: number, rol: string, estado: number): Promise<void> {
    const t = await this.findById(id);
    if (rol !== 'ADMIN' && t.user_id !== userId) {
      throw new ForbiddenException('No tienes permiso sobre esta transmisión');
    }
    await this.repo.update(id, { grabacion_activa: estado });
  }

  async eliminar(id: number, userId: number, rol: string): Promise<void> {
    const t = await this.findById(id);
    if (rol !== 'ADMIN' && t.user_id !== userId) {
      throw new ForbiddenException('No tienes permiso sobre esta transmisión');
    }
    await this.repo.delete(id);
  }

  async findByCameraId(cameraId: string): Promise<Transmision | null> {
    // cameraId en el signaling gateway puede ser el nombre o un identificador
    return this.repo.findOne({ where: { id: +cameraId }, relations: { gateway: true } });
  }
}
