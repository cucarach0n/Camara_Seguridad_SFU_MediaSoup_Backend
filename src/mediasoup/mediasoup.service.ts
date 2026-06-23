import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as mediasoup from 'mediasoup';
import { types } from 'mediasoup';
import { config } from './config';

@Injectable()
export class MediasoupService implements OnModuleInit {
  private readonly logger = new Logger(MediasoupService.name);
  private worker: types.Worker;
  private router: types.Router;

  async onModuleInit() {
    await this.initMediasoup();
  }

  private async initMediasoup() {
    this.worker = await mediasoup.createWorker({
      logLevel: config.worker.logLevel as any,
      logTags: config.worker.logTags as any[],
      rtcMinPort: config.worker.rtcMinPort,
      rtcMaxPort: config.worker.rtcMaxPort,
    });

    this.worker.on('died', () => {
      this.logger.error('Mediasoup worker died, exiting in 2 seconds... [pid:%d]', this.worker.pid);
      setTimeout(() => process.exit(1), 2000);
    });

    this.logger.log(`Mediasoup worker created [pid:${this.worker.pid}]`);

    this.router = await this.worker.createRouter({ mediaCodecs: config.router.mediaCodecs });
    this.logger.log('Mediasoup router created');
  }

  getRouterRtpCapabilities() {
    return this.router.rtpCapabilities;
  }

  async createWebRtcTransport(): Promise<types.WebRtcTransport> {
    const transport = await this.router.createWebRtcTransport({
      listenIps: config.webRtcTransport.listenIps,
      enableUdp: config.webRtcTransport.enableUdp,
      enableTcp: config.webRtcTransport.enableTcp,
      preferUdp: config.webRtcTransport.preferUdp,
      initialAvailableOutgoingBitrate: config.webRtcTransport.initialAvailableOutgoingBitrate,
    });

    transport.on('dtlsstatechange', dtlsState => {
      if (dtlsState === 'closed') transport.close();
    });

    transport.on('@close', () => {
      this.logger.log(`Transport closed: ${transport.id}`);
    });

    return transport;
  }

  async createPlainTransport(options?: Partial<types.PlainTransportOptions>): Promise<types.PlainTransport> {
    const plainTransportOptions: any = {
      listenIp: config.plainTransport.listenIp,
      rtcpMux: false,
      comedia: false,
      ...options,
    };
    return await this.router.createPlainTransport(plainTransportOptions);
  }

  getRouter() {
    return this.router;
  }
}
