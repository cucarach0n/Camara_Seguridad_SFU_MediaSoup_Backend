import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Grabacion } from './entities/grabacion.entity';
import { GoogleDriveService } from '../google-drive/google-drive.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class GrabacionesService {
  constructor(
    @InjectRepository(Grabacion)
    private repo: Repository<Grabacion>,
    private googleDriveService: GoogleDriveService
  ) {}

  async registrarInicio(data: {
    user_id: number;
    transmision_id: number | null;
    nombre_archivo: string;
    ruta_archivo: string;
    creado_en?: Date;
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

  async marcarSubidaDrivePorNombre(nombre_archivo: string, url_drive: string) {
    await this.repo.update({ nombre_archivo }, { subido_drive: 1, url_drive });
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

  async delete(id: number, userId: number, rol: string): Promise<void> {
    const grabacion = await this.getById(id, userId, rol);

    // Borrar de disco si existe
    if (grabacion.ruta_archivo && grabacion.nombre_archivo) {
      const filePath = path.join(__dirname, '..', '..', '..', 'recordings', grabacion.ruta_archivo, grabacion.nombre_archivo);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      const markerPath = `${filePath}.uploaded`;
      if (fs.existsSync(markerPath)) {
        fs.unlinkSync(markerPath);
      }
    }

    // Borrar de Google Drive si fue subido
    if (grabacion.subido_drive && grabacion.url_drive) {
      const match = grabacion.url_drive.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        await this.googleDriveService.deleteFile(match[1]);
      }
    }

    await this.repo.remove(grabacion);
  }
}
