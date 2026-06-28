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

  async getOrCreateFolder(folderName: string, parentId: string): Promise<string | null> {
    if (!this.drive) return null;
    try {
      const res = await this.drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${parentId}' in parents and trashed=false`,
        fields: 'files(id, name)',
        spaces: 'drive',
      });
      if (res.data.files && res.data.files.length > 0) {
        return res.data.files[0].id || null;
      }
      
      const fileMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      };
      const createRes = await this.drive.files.create({
        requestBody: fileMetadata,
        fields: 'id'
      });
      return createRes.data.id || null;
    } catch (e) {
      this.logger.error(`Error buscando/creando carpeta ${folderName}: ${e.message}`);
      return null;
    }
  }

  async uploadFile(filePath: string, fileName: string, userIdStr: string = 'NA', dateStr: string = ''): Promise<string | null> {
    if (!this.drive) {
      this.logger.error('Drive no está inicializado.');
      return null;
    }

    const baseFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!baseFolderId) {
      this.logger.error('GOOGLE_DRIVE_FOLDER_ID no está definido en el .env');
      return null;
    }

    let targetFolderId = baseFolderId;

    try {
      if (userIdStr && userIdStr !== 'NA') {
        const userFolderId = await this.getOrCreateFolder(`Usuario_${userIdStr}`, targetFolderId);
        if (userFolderId) targetFolderId = userFolderId;
      }
      
      if (dateStr) {
        const dateFolderId = await this.getOrCreateFolder(dateStr, targetFolderId);
        if (dateFolderId) targetFolderId = dateFolderId;
      }

      this.logger.log(`Subiendo a Google Drive: ${fileName} en carpeta ${targetFolderId}...`);
      
      const fileMetadata = {
        name: fileName,
        parents: [targetFolderId],
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

  async getFileStream(fileId: string, range?: string) {
    if (!this.drive) throw new Error('Drive no está inicializado');
    
    const headers: any = {};
    if (range) {
      headers['Range'] = range;
    }
    
    return this.drive.files.get({
      fileId: fileId,
      alt: 'media'
    }, {
      responseType: 'stream',
      headers: headers
    });
  }
}
