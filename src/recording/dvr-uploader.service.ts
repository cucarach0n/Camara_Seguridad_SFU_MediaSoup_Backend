import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { GoogleDriveService } from '../google-drive/google-drive.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class DvrUploaderService {
  private readonly logger = new Logger(DvrUploaderService.name);
  private readonly recordingsDir = path.join(__dirname, '..', '..', 'recordings');

  constructor(private googleDriveService: GoogleDriveService) {}

  // Se ejecuta cada 5 minutos
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCron() {
    if (!fs.existsSync(this.recordingsDir)) return;

    this.logger.debug('Buscando nuevos fragmentos de video para subir a Google Drive...');
    const now = Date.now();
    // Tiempo de "enfriamiento" de 2 minutos para asegurar que FFmpeg ya soltó el archivo
    const MIN_AGE_MS = 2 * 60 * 1000; 

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

        // Proceder a subir
        const success = await this.googleDriveService.uploadFile(filePath, file);

        if (success) {
          // Crear un archivo marcador vacío para no volver a subirlo
          fs.writeFileSync(markerPath, '');
          this.logger.log(`Video marcado como subido: ${file}`);
        }
      }
    }
  }
}
