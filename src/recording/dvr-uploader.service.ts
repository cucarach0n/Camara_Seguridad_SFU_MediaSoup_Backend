import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { GoogleDriveService } from '../google-drive/google-drive.service';
import { GrabacionesService } from '../grabaciones/grabaciones.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class DvrUploaderService {
  private readonly logger = new Logger(DvrUploaderService.name);
  private readonly recordingsDir = path.join(__dirname, '..', '..', 'recordings');

  constructor(
    private googleDriveService: GoogleDriveService,
    private grabacionesService: GrabacionesService
  ) {}

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
        const markerPath = `${filePath}.uploaded`;

        // Si ya está subido, lo ignoramos
        if (fs.existsSync(markerPath)) continue;

        const stat = fs.statSync(filePath);
        const ageMs = now - stat.mtimeMs;

        // Si el archivo se modificó hace menos de 2 minutos, probablemente FFmpeg aún lo está escribiendo
        if (ageMs < MIN_AGE_MS) continue;

        // El formato es: rec__streamerId__transmisionId__userId__fecha_hora.mp4
        let transmisionId: number | null = null;
        let userId: number | null = null;
        const parts = file.split('__');
        if (parts.length >= 5) {
          transmisionId = parts[2] !== 'NA' ? parseInt(parts[2], 10) : null;
          userId = parts[3] !== 'NA' ? parseInt(parts[3], 10) : null;
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
            });
            grabacionId = g.id;
            
            // Inmediatamente finalizarlo con su tamaño
            await this.grabacionesService.finalizar(grabacionId, stat.size, 0, file);
          } catch (dbErr) {
            this.logger.error(`Error registrando el fragmento ${file} en BD:`, dbErr);
            // Seguimos adelante para no bloquear la subida a Drive
          }
        }

        // Proceder a subir
        const fileId = await this.googleDriveService.uploadFile(filePath, file);

        if (fileId) {
          // Crear un archivo marcador vacío para no volver a subirlo
          fs.writeFileSync(markerPath, '');
          this.logger.log(`Video subido y marcado localmente: ${file}`);
          
          if (grabacionId) {
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
}
