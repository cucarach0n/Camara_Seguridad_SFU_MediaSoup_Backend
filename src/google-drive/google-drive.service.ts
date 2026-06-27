import { Injectable, Logger } from '@nestjs/common';
import { google, drive_v3 } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class GoogleDriveService {
  private readonly logger = new Logger(GoogleDriveService.name);
  private drive: drive_v3.Drive;

  constructor() {
    this.initDrive();
  }

  private initDrive() {
    try {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

      if (!clientId || !clientSecret || !refreshToken) {
        this.logger.warn('Faltan credenciales OAuth2 de Google Drive en el .env. La subida estará deshabilitada.');
        return;
      }

      const oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        'https://developers.google.com/oauthplayground' // Redirect URI (estándar para playground)
      );

      oauth2Client.setCredentials({
        refresh_token: refreshToken,
      });

      this.drive = google.drive({ version: 'v3', auth: oauth2Client });
      this.logger.log('Google Drive API inicializada correctamente.');
    } catch (error) {
      this.logger.error('Error inicializando Google Drive:', error);
    }
  }

  async uploadFile(filePath: string, fileName: string): Promise<string | null> {
    if (!this.drive) {
      this.logger.error('Drive no está inicializado.');
      return null;
    }

    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) {
      this.logger.error('GOOGLE_DRIVE_FOLDER_ID no está definido en el .env');
      return null;
    }

    try {
      this.logger.log(`Subiendo a Google Drive: ${fileName}...`);
      
      const fileMetadata = {
        name: fileName,
        parents: [folderId],
      };
      
      const media = {
        mimeType: fileName.endsWith('.webm') ? 'video/webm' : 'video/mp4',
        body: fs.createReadStream(filePath),
      };

      const res = await this.drive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id',
      });

      this.logger.log(`Subida completada. File ID: ${res.data.id}`);
      return res.data.id || null;
    } catch (error) {
      this.logger.error(`Error subiendo el archivo ${fileName} a Google Drive:`, error);
      return null;
    }
  }

  async deleteFile(fileId: string): Promise<boolean> {
    if (!this.drive) {
      this.logger.error('Drive no está inicializado.');
      return false;
    }

    try {
      this.logger.log(`Eliminando archivo de Google Drive. File ID: ${fileId}...`);
      await this.drive.files.delete({ fileId });
      this.logger.log(`Archivo eliminado de Google Drive. File ID: ${fileId}`);
      return true;
    } catch (error) {
      this.logger.error(`Error eliminando el archivo ${fileId} de Google Drive:`, error);
      return false;
    }
  }
}
