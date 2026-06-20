import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class DvrCleanerService {
  private readonly logger = new Logger(DvrCleanerService.name);
  private readonly recordingsDir = path.join(__dirname, '..', '..', 'recordings');
  private readonly MAX_DAYS = 7;

  // Se ejecuta todos los días a las 2:00 AM
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  handleCron() {
    this.logger.log('Iniciando limpieza del DVR (Archivos de más de 7 días)...');
    
    if (!fs.existsSync(this.recordingsDir)) {
      return;
    }

    const now = Date.now();
    const maxAgeMs = this.MAX_DAYS * 24 * 60 * 60 * 1000;

    const directories = fs.readdirSync(this.recordingsDir);

    for (const dir of directories) {
      const dirPath = path.join(this.recordingsDir, dir);
      const stat = fs.statSync(dirPath);

      if (stat.isDirectory()) {
        // Asumiendo que el nombre del directorio es YYYY-MM-DD
        const dirDate = new Date(dir).getTime();
        
        // Si el directorio no es una fecha válida, fallback al stat.mtimeMs
        const ageMs = isNaN(dirDate) ? (now - stat.mtimeMs) : (now - dirDate);

        if (ageMs > maxAgeMs) {
          this.logger.log(`Borrando directorio antiguo del DVR: ${dirPath}`);
          fs.rmSync(dirPath, { recursive: true, force: true });
        }
      }
    }
    
    this.logger.log('Limpieza del DVR finalizada.');
  }
}
