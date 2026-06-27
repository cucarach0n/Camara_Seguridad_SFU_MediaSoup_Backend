import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class DvrCleanerService {
  private readonly logger = new Logger(DvrCleanerService.name);
  private readonly recordingsDir = path.join(__dirname, '..', '..', 'recordings');
  private readonly MAX_DAYS = 1;
  private readonly CRITICAL_SPACE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

  // Se ejecuta todos los días a las 2:00 AM
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  handleCron() {
    this.logger.log('Iniciando limpieza del DVR (Archivos de más de 24 horas)...');
    
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

  // Monitoreo de espacio en disco continuo (cada minuto)
  @Cron(CronExpression.EVERY_MINUTE)
  checkDiskSpace() {
    if (!fs.existsSync(this.recordingsDir)) return;
    
    try {
      // fs.statfsSync está disponible en Node >= 19
      const stats = fs.statfsSync(this.recordingsDir);
      // bavail es el total de bloques disponibles para el usuario no privilegiado
      const freeSpace = stats.bavail * stats.bsize;
      
      if (freeSpace < this.CRITICAL_SPACE_BYTES) {
        this.logger.warn(`¡ESPACIO CRÍTICO! Solo quedan ${Math.round(freeSpace / 1024 / 1024)} MB. Eliminando los 2 videos más antiguos.`);
        this.emergencyCleanup(2);
      }
    } catch (e) {
      this.logger.error('Error comprobando espacio en disco:', e);
    }
  }

  private emergencyCleanup(count: number) {
    const directories = fs.readdirSync(this.recordingsDir);
    let allFiles: { path: string; mtimeMs: number }[] = [];

    for (const dir of directories) {
      const dirPath = path.join(this.recordingsDir, dir);
      if (fs.statSync(dirPath).isDirectory()) {
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.mp4'));
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          allFiles.push({ path: filePath, mtimeMs: fs.statSync(filePath).mtimeMs });
        }
      }
    }

    // Ordenar de más antiguo a más reciente
    allFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);

    // Borrar los 'count' más antiguos
    for (let i = 0; i < count && i < allFiles.length; i++) {
      try {
        this.logger.warn(`Borrando archivo antiguo de emergencia para liberar espacio: ${allFiles[i].path}`);
        fs.unlinkSync(allFiles[i].path);
        // Borrar el marcador si existe para no dejar basura
        const markerPath = `${allFiles[i].path}.uploaded`;
        if (fs.existsSync(markerPath)) {
          fs.unlinkSync(markerPath);
        }
      } catch (e) {
        this.logger.error(`Error al borrar de emergencia ${allFiles[i].path}`, e);
      }
    }
  }
}
