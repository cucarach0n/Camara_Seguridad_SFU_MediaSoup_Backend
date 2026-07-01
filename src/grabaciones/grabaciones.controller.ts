import { Controller, Get, Delete, Param, Request, UseGuards, ParseIntPipe, Res, HttpStatus } from '@nestjs/common';
import { GrabacionesService } from './grabaciones.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import * as fs from 'fs';
import * as path from 'path';
import type { Response } from 'express';
import { GoogleDriveService } from '../google-drive/google-drive.service';

@Controller('grabaciones')
@UseGuards(JwtAuthGuard)
export class GrabacionesController {
  constructor(
    private service: GrabacionesService,
    private driveService: GoogleDriveService
  ) {}

  @Get()
  listar(@Request() req) {
    return this.service.getList(req.user.id, req.user.rol);
  }

  @Get(':id')
  obtenerUno(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.service.getById(id, req.user.id, req.user.rol);
  }

  @Delete(':id')
  async eliminar(@Param('id', ParseIntPipe) id: number, @Request() req) {
    await this.service.delete(id, req.user.id, req.user.rol);
    return { success: true, message: 'Grabación eliminada correctamente' };
  }

  @Get('stream/:id')
  async streamVideo(@Param('id', ParseIntPipe) id: number, @Request() req, @Res() res: Response) {
    try {
      const record = await this.service.getById(id, req.user.id, req.user.rol);
      
      const localPath = path.join(__dirname, '..', '..', 'recordings', record.ruta_archivo, record.nombre_archivo);
      
      if (fs.existsSync(localPath)) {
        // Stream local file
        const stat = fs.statSync(localPath);
        const fileSize = stat.size;
        const range = req.headers.range;

        if (range) {
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
          const chunksize = (end - start) + 1;
          const file = fs.createReadStream(localPath, { start, end });
          const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': record.nombre_archivo.endsWith('.webm') ? 'video/webm' : 'video/mp4',
          };
          res.writeHead(206, head);
          file.pipe(res);
        } else {
          const head = {
            'Content-Length': fileSize,
            'Content-Type': record.nombre_archivo.endsWith('.webm') ? 'video/webm' : 'video/mp4',
          };
          res.writeHead(200, head);
          fs.createReadStream(localPath).pipe(res);
        }
      } else if (record.url_drive) {
        // Extract fileId from Drive URL: https://drive.google.com/file/d/FILE_ID/view
        const match = record.url_drive.match(/\/d\/([a-zA-Z0-9_-]+)\//);
        if (match && match[1]) {
          const fileId = match[1];
          const driveRes = await this.driveService.getFileStream(fileId, req.headers.range);
          
          const safeHeaders = [
            'content-type',
            'content-length',
            'content-range',
            'accept-ranges'
          ];
          for (const key of safeHeaders) {
             const val = driveRes.headers[key];
             if (val !== undefined) res.setHeader(key, val as any);
          }
          res.status(driveRes.status);
          driveRes.data.pipe(res);
        } else {
          res.status(HttpStatus.NOT_FOUND).send('Drive URL inválida');
        }
      } else {
        res.status(HttpStatus.NOT_FOUND).send('Video no encontrado');
      }
    } catch (e) {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(e.message);
    }
  }
}
