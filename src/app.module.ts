import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MediasoupService } from './mediasoup/mediasoup.service';
import { SignalingGateway } from './signaling/signaling.gateway';
import { RecordingService } from './recording/recording.service';
import { DvrCleanerService } from './recording/dvr-cleaner.service';
import { GoogleDriveService } from './google-drive/google-drive.service';
import { DvrUploaderService } from './recording/dvr-uploader.service';

@Module({
  imports: [
    ScheduleModule.forRoot()
  ],
  controllers: [AppController],
  providers: [
    AppService, 
    MediasoupService, 
    RecordingService, 
    SignalingGateway, 
    DvrCleanerService, 
    GoogleDriveService, 
    DvrUploaderService
  ],
})
export class AppModule {}
