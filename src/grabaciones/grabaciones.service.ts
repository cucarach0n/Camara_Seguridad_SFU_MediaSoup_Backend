import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Grabacion } from './entities/grabacion.entity';

@Injectable()
export class GrabacionesService {
  constructor(
    @InjectRepository(Grabacion)
    private repo: Repository<Grabacion>,
  ) {}

  async registrarInicio(data: {
    user_id: number;
    transmision_id: number | null;
    nombre_archivo: string;
    ruta_archivo: string;
  }): Promise<Grabacion> {
    const grabacion = this.repo.create(data);
    return this.repo.save(grabacion);
  }

  async finalizar(id: number, tamanio_bytes: number, duracion_segundos: number, nombre_archivo?: string) {
    const updateData: any = { tamanio_bytes, duracion_segundos };
    if (nombre_archivo) updateData.nombre_archivo = nombre_archivo;
    await this.repo.update(id, updateData);
  }

  async marcarSubidaDrive(id: number, url_drive: string) {
    await this.repo.update(id, { subido_drive: 1, url_drive });
  }

  async getList(userId: number, rol: string): Promise<Grabacion[]> {
    const query = this.repo.createQueryBuilder('g')
      .leftJoinAndSelect('g.usuario', 'u')
      .leftJoinAndSelect('g.transmision', 't')
      .orderBy('g.creado_en', 'DESC');

    if (rol !== 'ADMIN') {
      query.where('g.user_id = :userId', { userId });
    }
    return query.getMany();
  }

  async getById(id: number, userId: number, rol: string): Promise<Grabacion> {
    const query = this.repo.createQueryBuilder('g')
      .leftJoinAndSelect('g.usuario', 'u')
      .leftJoinAndSelect('g.transmision', 't')
      .where('g.id = :id', { id });

    if (rol !== 'ADMIN') {
      query.andWhere('g.user_id = :userId', { userId });
    }
    
    const grabacion = await query.getOne();
    if (!grabacion) throw new NotFoundException('Grabación no encontrada o sin permisos');
    return grabacion;
  }
}
