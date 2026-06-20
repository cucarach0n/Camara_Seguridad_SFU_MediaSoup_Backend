import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MediasoupService } from './mediasoup/mediasoup.service';
import { SignalingGateway } from './signaling/signaling.gateway';
import { RecordingService } from './recording/recording.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService, MediasoupService, RecordingService, SignalingGateway],
})
export class AppModule {}
