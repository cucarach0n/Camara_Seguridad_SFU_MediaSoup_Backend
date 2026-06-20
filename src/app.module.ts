import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MediasoupService } from './mediasoup/mediasoup.service';
import { SignalingGateway } from './signaling/signaling.gateway';
import { RecordingService } from './recording/recording.service';
import { DvrCleanerService } from './recording/dvr-cleaner.service';

@Module({
  imports: [
    ScheduleModule.forRoot()
  ],
  controllers: [AppController],
  providers: [AppService, MediasoupService, RecordingService, SignalingGateway, DvrCleanerService],
})
export class AppModule {}
