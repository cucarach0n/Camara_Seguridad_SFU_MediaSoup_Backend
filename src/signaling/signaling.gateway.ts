import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MediasoupService } from '../mediasoup/mediasoup.service';
import { RecordingService } from '../recording/recording.service';
import { types } from 'mediasoup';
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@WebSocketGateway({ cors: true })
export class SignalingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private logger = new Logger(SignalingGateway.name);

  // Mappings to track state per peer
  private transports: Map<string, types.Transport> = new Map();
  private producers: Map<string, types.Producer> = new Map();
  private consumers: Map<string, types.Consumer> = new Map();
  private streamerSocketId: string | null = null;

  constructor(
    private mediasoupService: MediasoupService,
    private recordingService: RecordingService
  ) {}

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    const recordingMode = process.env.RECORDING_MODE || 'A';
    client.emit('config-mode', recordingMode);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    // Clean up
    if (this.streamerSocketId === client.id) {
      this.streamerSocketId = null;
      this.server.emit('streamer-disconnected');
      
      const recordingMode = process.env.RECORDING_MODE || 'A';
      if (recordingMode === 'B') {
        this.recordingService.stopRecording(client.id);
      }
    }
    const transportsToClose = [...this.transports.entries()].filter(([id]) => id.startsWith(client.id));
    for (const [id, transport] of transportsToClose) {
      transport.close();
      this.transports.delete(id);
    }
  }

  @SubscribeMessage('getRouterRtpCapabilities')
  handleGetRouterRtpCapabilities() {
    return this.mediasoupService.getRouterRtpCapabilities();
  }

  @SubscribeMessage('createWebRtcTransport')
  async handleCreateTransport(@ConnectedSocket() client: Socket) {
    const transport = await this.mediasoupService.createWebRtcTransport();
    this.transports.set(`${client.id}_${transport.id}`, transport);

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  @SubscribeMessage('connectTransport')
  async handleConnectTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { transportId: string; dtlsParameters: any },
  ) {
    const transport = this.transports.get(`${client.id}_${data.transportId}`);
    if (!transport) throw new Error('Transport not found');
    await transport.connect({ dtlsParameters: data.dtlsParameters });
    return true;
  }

  @SubscribeMessage('produce')
  async handleProduce(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { transportId: string; kind: 'audio'|'video'; rtpParameters: any },
  ) {
    const transport = this.transports.get(`${client.id}_${data.transportId}`);
    if (!transport) throw new Error('Transport not found');
    
    const producer = await transport.produce({
      kind: data.kind,
      rtpParameters: data.rtpParameters,
      appData: { socketId: client.id }
    });
    
    this.producers.set(producer.id, producer);

    producer.on('transportclose', () => {
      this.producers.delete(producer.id);
    });
    
    if (data.kind === 'video') {
      this.streamerSocketId = client.id;
      client.broadcast.emit('new-producer', producer.id);
    }

    return { id: producer.id };
  }

  @SubscribeMessage('consume')
  async handleConsume(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { producerId: string; rtpCapabilities: any },
  ) {
    const router = this.mediasoupService.getRouter();
    if (!router.canConsume({ producerId: data.producerId, rtpCapabilities: data.rtpCapabilities })) {
      throw new Error('Cannot consume');
    }

    const transportEntry = [...this.transports.entries()].find(([id]) => id.startsWith(client.id));
    if (!transportEntry) throw new Error('Transport not found');
    const transport = transportEntry[1];

    const consumer = await transport.consume({
      producerId: data.producerId,
      rtpCapabilities: data.rtpCapabilities,
      paused: true,
    });

    this.consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => {
      this.consumers.delete(consumer.id);
    });

    consumer.on('producerclose', () => {
      this.consumers.delete(consumer.id);
      client.emit('producer-closed', { consumerId: consumer.id });
    });

    return {
      id: consumer.id,
      producerId: data.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    };
  }

  @SubscribeMessage('resume')
  async handleResume(@MessageBody() data: { consumerId: string }) {
    const consumer = this.consumers.get(data.consumerId);
    if (!consumer) throw new Error('Consumer not found');
    await consumer.resume();
    return true;
  }

  // --- MODO A: Chunk recording ---
  @SubscribeMessage('video-chunk')
  handleVideoChunk(@ConnectedSocket() client: Socket, @MessageBody() data: ArrayBuffer) {
    const recordingMode = process.env.RECORDING_MODE || 'A';
    if (recordingMode === 'A') {
      const fileName = path.join(__dirname, '..', '..', `recording-${client.id}.webm`);
      fs.appendFileSync(fileName, Buffer.from(data));
    }
  }

  @SubscribeMessage('getStreamerId')
  handleGetStreamerId() {
    // Retorna los producer IDs disponibles del streamer actual
    const producerIds = [...this.producers.keys()];
    return producerIds;
  }

  @SubscribeMessage('start-recording')
  async handleStartRecording(@ConnectedSocket() client: Socket) {
    const recordingMode = process.env.RECORDING_MODE || 'A';
    if (recordingMode === 'B') {
      const myProducers = [...this.producers.values()].filter(p => p.appData.socketId === client.id);
      this.recordingService.startRecording(myProducers, client.id);
    }
  }
}
