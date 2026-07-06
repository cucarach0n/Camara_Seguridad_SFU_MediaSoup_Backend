import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { GoogleDriveService } from '../google-drive/google-drive.service';
import { GrabacionesService } from '../grabaciones/grabaciones.service';
import * as fs from 'fs';
import * as path from 'path';
const ffmpeg = require('fluent-ffmpeg');

@Injectable()
export class DvrUploaderService {
  private readonly logger = new Logger(DvrUploaderService.name);
  private readonly recordingsDir = path.join(__dirname, '..', '..', 'recordings');

  constructor(
    private googleDriveService: GoogleDriveService,
    private grabacionesService: GrabacionesService
  ) {}

  private getVideoDuration(filePath: string): Promise<number> {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err || !metadata || !metadata.format || !metadata.format.duration) {
          return resolve(0);
        }
        resolve(Math.floor(metadata.format.duration));
      });
    });
  }

  // Se ejecuta cada 5 minutos
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCron() {
    await this.processFiles(true);
  }

  async processAllImmediate() {
    this.logger.debug('Procesamiento inmediato invocado (bypass cooling time)...');
    await this.processFiles(false);
  }

  private async processFiles(useCoolingTime: boolean) {
    if (!fs.existsSync(this.recordingsDir)) return;

    this.logger.debug('Buscando nuevos fragmentos de video para subir a Google Drive...');
    const now = Date.now();
    // Tiempo de "enfriamiento" de 2 minutos para asegurar que FFmpeg ya soltó el archivo
    const MIN_AGE_MS = useCoolingTime ? 2 * 60 * 1000 : 0; 

    const directories = fs.readdirSync(this.recordingsDir);

    for (const dir of directories) {
      const dirPath = path.join(this.recordingsDir, dir);
      if (!fs.statSync(dirPath).isDirectory()) continue;

      const files = fs.readdirSync(dirPath);
      
      // Filtrar solo mp4 y webm
      const videoFiles = files.filter(f => f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mkv'));

      for (const file of videoFiles) {
        const filePath = path.join(dirPath, file);
        const markerPath = `${filePath}.processed`;

        // Si ya está procesado y registrado en DB, lo ignoramos
        if (fs.existsSync(markerPath)) continue;

        // Soporte temporal para marcadores antiguos
        if (fs.existsSync(`${filePath}.uploaded`)) {
          fs.renameSync(`${filePath}.uploaded`, markerPath);
          continue;
        }

        const stat = fs.statSync(filePath);
        const ageMs = now - stat.mtimeMs;

        // Si el archivo se modificó hace menos de 2 minutos, probablemente FFmpeg aún lo está escribiendo
        if (ageMs < MIN_AGE_MS) continue;

        // El formato es: rec__streamerId__transmisionId__userId__fecha_hora.mp4
        let transmisionId: number | null = null;
        let userId: number | null = null;
        let duracion_segundos = 0;
        let startDate: Date | undefined;
        const parts = file.split('__');
        if (parts.length >= 5) {
          transmisionId = parts[2] !== 'NA' ? parseInt(parts[2], 10) : null;
          userId = parts[3] !== 'NA' ? parseInt(parts[3], 10) : null;

          try {
            const dateStr = parts[4].replace('.mp4', '').replace('.webm', '').replace('.mkv', '');
            if (dateStr.length >= 15) { // ej: 20260627_110335
              const year = parseInt(dateStr.substring(0, 4), 10);
              const month = parseInt(dateStr.substring(4, 6), 10) - 1;
              const day = parseInt(dateStr.substring(6, 8), 10);
              const hour = parseInt(dateStr.substring(9, 11), 10);
              const min = parseInt(dateStr.substring(11, 13), 10);
              const sec = parseInt(dateStr.substring(13, 15), 10);
              
              startDate = new Date(year, month, day, hour, min, sec);
              const duracion_matematica = Math.floor((stat.mtimeMs - startDate.getTime()) / 1000);
              const duracion_real = await this.getVideoDuration(filePath);
              
              duracion_segundos = duracion_real > 0 ? duracion_real : Math.max(0, duracion_matematica);
            }
          } catch (err) {
            this.logger.warn(`No se pudo extraer la fecha de inicio del archivo: ${file}`);
          }
        }

        // Crear el registro en la Base de Datos ya que el archivo está listo
        let grabacionId: number | null = null;
        if (userId) {
          try {
            const fechaDir = path.basename(dirPath);
            const g = await this.grabacionesService.registrarInicio({
              user_id: userId,
              transmision_id: transmisionId,
              nombre_archivo: file,
              ruta_archivo: fechaDir,
              creado_en: startDate,
            });
            grabacionId = g.id;
            
            // Inmediatamente finalizarlo con su tamaño y duración
            await this.grabacionesService.finalizar(grabacionId, stat.size, duracion_segundos, file);
            
            // Crear el marcador para no volver a procesarlo NUNCA MÁS (independiente de si Drive funciona o no)
            fs.writeFileSync(markerPath, '');
            this.logger.log(`Video registrado en BD y marcado como procesado: ${file}`);
          } catch (dbErr) {
            this.logger.error(`Error registrando el fragmento ${file} en BD:`, dbErr);
            // No creamos el marcador para que se intente registrar en el siguiente ciclo
            continue; 
          }
        }

        // Proceder a subir (opcional, si Drive está configurado)
        const fileId = await this.googleDriveService.uploadFile(filePath, file, userId ? userId.toString() : 'NA', dir);

        if (fileId && grabacionId) {
          try {
            const urlDrive = `https://drive.google.com/file/d/${fileId}/view`;
            await this.grabacionesService.marcarSubidaDrive(grabacionId, urlDrive);
            this.logger.log(`Base de datos actualizada con URL de Drive para ID: ${grabacionId}`);
          } catch (dbErr) {
            this.logger.error(`Error actualizando base de datos tras subida de ${file}:`, dbErr);
          }
        }
      }
    }
  }
}
