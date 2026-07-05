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

// Fase 3
import { JwtService } from '@nestjs/jwt';
import { GatewaysDbService } from '../gateways-db/gateways-db.service';
import { TransmisionesService } from '../transmisiones/transmisiones.service';
import { WsAuthMiddleware } from './ws-auth.middleware';

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

  // RTSP Gateways state
  private gateways: Map<string, { gatewayId: string; cameras: Array<{ id: string; name: string; rtspUrl: string }> }> = new Map();
  private rtspStreams: Map<string, {
    videoTransport: types.PlainTransport;
    audioTransport: types.PlainTransport | null;
    videoProducer: types.Producer;
    audioProducer: types.Producer | null;
  }> = new Map();
  private cameraViewers: Map<string, Set<string>> = new Map();
  private rtspCamerasStatus: Map<string, boolean> = new Map();

  // Mapa para reconectar webcams persistentes (socket.id -> webcam-transmisionId)
  private socketStreamerMap: Map<string, string> = new Map();

  constructor(
    private mediasoupService: MediasoupService,
    private recordingService: RecordingService,
    private jwtService: JwtService,
    private gatewaysDbService: GatewaysDbService,
    private transmisionesService: TransmisionesService,
  ) {}

  afterInit(server: Server) {
    server.use(WsAuthMiddleware(this.jwtService, this.gatewaysDbService));
    
    // Iniciar sondeo automático a Gateways cada 10 segundos
    setInterval(async () => {
      try {
        const transList = await this.transmisionesService.getList(0, 'ADMIN'); // ADMIN gets all
        const rtspList = transList.filter(t => t.tipo_origen === 'RTSP' && t.gateway);
        
        // Agrupar por gateway
        const byGateway = new Map<string, any[]>();
        rtspList.forEach(t => {
          const gwId = t.gateway?.identificador;
          if (gwId) {
            if (!byGateway.has(gwId)) byGateway.set(gwId, []);
            byGateway.get(gwId)!.push({ id: t.id.toString(), rtspUrl: t.url_rtsp });
          }
        });
        
        for (const [gatewayId, cameras] of byGateway.entries()) {
          const gwSockets = [...this.server.sockets.sockets.values()].filter(s => s.data.isGateway && s.data.gatewayId === gatewayId);
          if (gwSockets.length > 0) {
            gwSockets.forEach(s => s.emit('probe-cameras', cameras));
          }
        }
      } catch (e) {
        this.logger.error(`Error en validación periódica RTSP: ${e}`);
      }
    }, 10000);
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    
    // Solo enviamos configuración a usuarios, no a gateways
    if (!client.data.isGateway) {
      const recordingMode = process.env.RECORDING_MODE || 'A';
      client.emit('config-mode', recordingMode);

      // Enviar lista filtrada por rol de usuario
      this.broadcastCamerasToUser(client);
    } else {
      // Es un gateway. Lo marcamos en la BD como conectado
      this.gatewaysDbService.marcarConectado(client.data.gatewayDbId, 1);
      this.gateways.set(client.id, { gatewayId: client.data.gatewayId, cameras: [] }); // cameras ya no se usa localmente, viene de BD
      this.broadcastCameras();
    }
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.chunkFiles.delete(client.id);

    // Si el cliente desconectado es un gateway
    if (client.data.isGateway) {
      // 1. Marcar como desconectado en BD
      this.gatewaysDbService.marcarConectado(client.data.gatewayDbId, 0);
      
      const gatewayId = client.data.gatewayId;
      
      // 2. Apagar todas las transmisiones activas que dependían de este gateway local
      for (const [cameraId, streamInfo] of this.rtspStreams.entries()) {
        const trans = await this.transmisionesService.findByCameraId(cameraId);
        if (trans && trans.gateway?.identificador === gatewayId) {
          this.logger.warn(`Gateway ${gatewayId} desconectado. Apagando stream de cámara ${cameraId}`);
          this.stopRtspStream(cameraId);
        }
      }

      // 3. Marcar todas las cámaras de este gateway como OFFLINE
      let changed = false;
      const allTransmisiones = await this.transmisionesService.getList(0, 'ADMIN');
      for (const t of allTransmisiones) {
        if (t.tipo_origen === 'RTSP' && t.gateway?.identificador === gatewayId) {
          if (this.rtspCamerasStatus.get(t.id.toString()) !== false) {
            this.rtspCamerasStatus.set(t.id.toString(), false);
            changed = true;
          }
        }
      }

      this.gateways.delete(client.id);
      
      if (changed) {
        this.broadcastCameras();
      } else {
        this.broadcastCameras(); // Broadcast anyway to update gateway state if needed
      }
    }

    // Si el cliente desconectado era espectador de alguna cámara IP
    for (const [cameraId, viewers] of this.cameraViewers.entries()) {
      if (viewers.has(client.id)) {
        this.removeViewerFromCamera(client.id, cameraId);
      }
    }

    // Clean up streamer
    if (this.streamerSocketId === client.id) {
      this.streamerSocketId = null;
      this.server.emit('streamer-disconnected', client.id);
    }
    
    const recordingMode = process.env.RECORDING_MODE || 'A';
    if (recordingMode === 'B') {
      const streamerId = this.socketStreamerMap.get(client.id) || client.id;
      this.recordingService.pauseRecording(streamerId);
      this.socketStreamerMap.delete(client.id);
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
    @MessageBody() data: { transportId: string; kind: 'audio'|'video'; rtpParameters: any; streamName?: string },
  ) {
    const transport = this.transports.get(`${client.id}_${data.transportId}`);
    if (!transport) throw new Error('Transport not found');
    
    const producer = await transport.produce({
      kind: data.kind,
      rtpParameters: data.rtpParameters,
      appData: { socketId: client.id, streamName: data.streamName }
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

    const producer = this.producers.get(data.producerId);
    if (!producer) throw new Error('Producer not found');

    const consumer = await transport.consume({
      producerId: data.producerId,
      rtpCapabilities: data.rtpCapabilities,
      paused: true,
      appData: { ...producer.appData, consumerSocketId: client.id },
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
      appData: consumer.appData,
    };
  }

  @SubscribeMessage('resume')
  async handleResume(@MessageBody() data: { consumerId: string }) {
    const consumer = this.consumers.get(data.consumerId);
    if (!consumer) throw new Error('Consumer not found');
    await consumer.resume();
    return true;
  }

  @SubscribeMessage('stop-streaming')
  async handleExplicitStopStreaming(@ConnectedSocket() client: Socket) {
    const streamerId = this.socketStreamerMap.get(client.id) || client.id;
    this.logger.log(`Deteniendo transmisión explícitamente para ${streamerId}`);

    // Limpiar para que el disconnect posterior no intente pausar
    this.socketStreamerMap.delete(client.id);

    const recordingMode = process.env.RECORDING_MODE || 'A';
    if (recordingMode === 'B') {
      await this.recordingService.stopRecording(streamerId);
    }
  }

  // --- MODO A: Chunk recording ---
  private chunkFiles: Map<string, { path: string; startTime: number }> = new Map();

  @SubscribeMessage('video-chunk')
  handleVideoChunk(@ConnectedSocket() client: Socket, @MessageBody() data: { chunk: ArrayBuffer, transmisionId: number }) {
    const recordingMode = process.env.RECORDING_MODE || 'A';
    if (recordingMode === 'A') {
      const now = Date.now();
      let fileInfo = this.chunkFiles.get(client.id);

      // Si no existe o han pasado más de 15 minutos (900000 ms)
      if (!fileInfo || (now - fileInfo.startTime) > 15 * 60 * 1000) {
        const nowTime = new Date();
        const dateStr = `${nowTime.getFullYear()}-${String(nowTime.getMonth()+1).padStart(2,'0')}-${String(nowTime.getDate()).padStart(2,'0')}`;
        const dirPath = path.join(__dirname, '..', '..', 'recordings', dateStr);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
        
        const timeStr = `${String(nowTime.getHours()).padStart(2,'0')}-${String(nowTime.getMinutes()).padStart(2,'0')}-${String(nowTime.getSeconds()).padStart(2,'0')}`;
        // Formato esperado por dvr-uploader: rec__[socketId]__[transmisionId]__[userId]__[fecha_hora].webm
        const fileName = path.join(dirPath, `rec__${client.id}__${data.transmisionId}__${client.data.user?.id || 'NA'}__${dateStr}_${timeStr}.webm`);
        
        fileInfo = { path: fileName, startTime: now };
        this.chunkFiles.set(client.id, fileInfo);
        this.logger.log(`Nuevo segmento de WebM creado: ${fileName}`);
      }

      fs.appendFileSync(fileInfo.path, Buffer.from(data.chunk));
    }
  }

  @SubscribeMessage('getStreamerId')
  handleGetStreamerId() {
    // Retorna los producer IDs disponibles
    return [...this.producers.keys()];
  }

  @SubscribeMessage('start-recording')
  async handleStartRecording(@ConnectedSocket() client: Socket, @MessageBody() data?: { transmisionId?: number }) {
    const recordingMode = process.env.RECORDING_MODE || 'A';
    if (recordingMode === 'B') {
      const myProducers = [...this.producers.values()].filter(p => p.appData.socketId === client.id);
      
      let tId = data?.transmisionId;
      if (!tId) {
        // Fallback: Busca si el usuario registró una transmisión web
        const transList = await this.transmisionesService.getList(client.data.user.id, 'USER');
        const transmision = transList.find(t => t.tipo_origen === 'NAVEGADOR');
        tId = transmision?.id;
      }
      
      const streamerId = tId ? `webcam-${tId}` : client.id;
      this.socketStreamerMap.set(client.id, streamerId);

      this.recordingService.startRecording(
        myProducers, 
        streamerId, 
        tId, 
        client.data.user?.id
      );
    }
  }

  // --- MÉTODOS DE INTEGRACIÓN RTSP GATEWAY ---

  @SubscribeMessage('register-gateway')
  async handleRegisterGateway(@ConnectedSocket() client: Socket) {
    // Ya validado en WsAuthMiddleware
    const gatewayId = client.data.gatewayId;
    this.logger.log(`Gateway registrado exitosamente: ${gatewayId}`);

    // Si hubo una desconexión temporal del gateway pero el backend seguía vivo,
    // los espectadores siguen esperando el video. Le decimos al gateway que retome
    // todas las transmisiones de sus cámaras que figuran como activas en el backend.
    for (const [cameraId, streamInfo] of this.rtspStreams.entries()) {
      try {
        const transmision = await this.transmisionesService.findByCameraId(cameraId);
        if (transmision && transmision.gateway && transmision.gateway.identificador === gatewayId) {
          const listenIp = process.env.LISTEN_IP || '127.0.0.1';
          this.logger.log(`Auto-recuperación: Re-emitiendo start-rtsp-stream al gateway ${gatewayId} para cámara ${cameraId}`);
          
          client.emit('start-rtsp-stream', {
            cameraId,
            rtspUrl: transmision.url_rtsp,
            videoPort: streamInfo.videoTransport.tuple.localPort,
            audioPort: streamInfo.audioTransport ? streamInfo.audioTransport.tuple.localPort : 0,
            backendIp: listenIp
          });
        }
      } catch (e) {
        this.logger.error(`Error en auto-recuperación de cámara ${cameraId} para gateway ${gatewayId}:`, e);
      }
    }

    return true;
  }

  @SubscribeMessage('get-rtsp-cameras')
  async handleGetRtspCameras(@ConnectedSocket() client: Socket) {
    if (client.data?.user) {
      try {
        const transList = await this.transmisionesService.getList(client.data.user.id, client.data.user.rol);
        const rtspList = transList.filter(t => t.tipo_origen === 'RTSP');
        return rtspList.map(t => ({
          id: t.id.toString(),
          name: t.nombre,
          isOnline: this.rtspCamerasStatus.get(t.id.toString()) || false,
          isLive: this.rtspStreams.has(t.id.toString()),
          grabacion_activa: t.grabacion_activa === 1
        }));
      } catch(e) {}
    }
    return [];
  }

  @SubscribeMessage('request-camera-stream')
  async handleRequestCameraStream(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { cameraId: string }
  ) {
    try {
      const { cameraId } = data; // cameraId ahora es el ID en la BD
      this.logger.log(`Viewer ${client.id} (user ${client.data.user.username}) solicita cámara: ${cameraId}`);

      // Verificar permisos en DB
      const transmision = await this.transmisionesService.findByCameraId(cameraId);
      if (!transmision || !transmision.gateway) {
        return { error: 'Transmisión o Gateway no encontrado' };
      }
      
      if (client.data.user.rol !== 'ADMIN' && transmision.user_id !== client.data.user.id) {
        return { error: 'No tienes permiso para ver esta cámara' };
      }

      let viewers = this.cameraViewers.get(cameraId);
      if (!viewers) {
        viewers = new Set();
        this.cameraViewers.set(cameraId, viewers);
      }
      viewers.add(client.id);

      // Si el stream ya está activo
      const activeStream = this.rtspStreams.get(cameraId);
      if (activeStream) {
        return {
          videoProducerId: activeStream.videoProducer.id,
          audioProducerId: activeStream.audioProducer ? activeStream.audioProducer.id : null
        };
      }

      // Buscar socket id del gateway conectado
      let gatewaySocketId: string | null = null;
      for (const [sId, gw] of this.gateways.entries()) {
        if (gw.gatewayId === transmision.gateway.identificador) {
          gatewaySocketId = sId;
          break;
        }
      }

      if (!gatewaySocketId) {
        return { error: `Gateway de la cámara ${cameraId} está offline` };
      }

      // 1. Crear PlainTransports de MediaSoup con comedia: true para el ingreso de paquetes RTP
    const videoTransport = await this.mediasoupService.createPlainTransport({ comedia: true });
    const audioTransport = await this.mediasoupService.createPlainTransport({ comedia: true });

    this.transports.set(`gateway_video_${videoTransport.id}`, videoTransport);
    this.transports.set(`gateway_audio_${audioTransport.id}`, audioTransport);

    // 2. Notificar al gateway local para iniciar el streaming RTP vía FFmpeg y esperar confirmación
    const listenIp = process.env.LISTEN_IP || '127.0.0.1';
    this.logger.log(`Emitiendo start-rtsp-stream a gateway para cámara: ${cameraId}`);

    const gatewayResponse = await new Promise<{ hasAudio: boolean } | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.logger.warn(`Timeout esperando respuesta del gateway local para cámara: ${cameraId}`);
        resolve(null);
      }, 10000);

      const gatewaySocket = this.server.sockets.sockets.get(gatewaySocketId);
      if (!gatewaySocket) {
        this.logger.error(`Gateway socket ${gatewaySocketId} no encontrado al intentar emitir start-rtsp-stream`);
        clearTimeout(timeout);
        resolve(null);
        return;
      }

      gatewaySocket.emit('start-rtsp-stream', {
        cameraId,
        rtspUrl: transmision.url_rtsp,
        videoPort: videoTransport.tuple.localPort,
        audioPort: audioTransport.tuple.localPort,
        backendIp: listenIp
      }, (ack: any) => {
        clearTimeout(timeout);
        this.logger.log(`Respuesta DIRECTA del gateway local para ${cameraId}: ${JSON.stringify(ack)}`);
        resolve(ack);
      });
    });

    const hasAudio = gatewayResponse ? gatewayResponse.hasAudio : false;

    // 3. Crear los productores en MediaSoup con codecs correspondientes
    const videoProducer = await videoTransport.produce({
      kind: 'video',
      rtpParameters: {
        codecs: [
          {
            mimeType: 'video/H264',
            payloadType: 101,
            clockRate: 90000,
            parameters: {
              'packetization-mode': 1,
              'profile-level-id': '42e01f',
              'level-asymmetry-allowed': 1
            }
          }
        ],
        encodings: [{ ssrc: 11111 }]
      },
      appData: { cameraId }
    });
    this.producers.set(videoProducer.id, videoProducer);

    let audioProducer: types.Producer | null = null;
    if (hasAudio) {
      audioProducer = await audioTransport.produce({
        kind: 'audio',
        rtpParameters: {
          codecs: [
            {
              mimeType: 'audio/opus',
              payloadType: 102,
              clockRate: 48000,
              channels: 2
            }
          ],
          encodings: [{ ssrc: 22222 }]
        },
        appData: { cameraId }
      });
      this.producers.set(audioProducer.id, audioProducer);
    } else {
      // Si la cámara no tiene audio, cerramos el PlainTransport de audio
      audioTransport.close();
      this.transports.delete(`gateway_audio_${audioTransport.id}`);
    }

    const activeProducers: types.Producer[] = [videoProducer];
    if (audioProducer) {
      activeProducers.push(audioProducer);
    }

    this.rtspStreams.set(cameraId, {
      videoTransport,
      audioTransport: hasAudio ? audioTransport : null,
      videoProducer,
      audioProducer
    });
    
    // Notificar a todos los clientes para que actualicen su UI a "EN VIVO"
    this.broadcastCameras();

    // Iniciar grabación del servidor (Modo B)
    const recordingMode = process.env.RECORDING_MODE || 'A';
    if (recordingMode === 'B') {
      this.recordingService.startRecording(
        activeProducers, 
        `rtsp-${cameraId}`, 
        transmision.id, 
        transmision.user_id
      );
    }

    // Notificar estado a todos
    this.broadcastCameras();

    // Broadcast a los clientes de que hay nuevos productores disponibles para consumir
    this.server.emit('new-producer', videoProducer.id);
    if (audioProducer) {
      this.server.emit('new-producer', audioProducer.id);
    }

    return {
      videoProducerId: videoProducer.id,
      audioProducerId: audioProducer ? audioProducer.id : null
    };
    } catch(e) {
      this.logger.error(`Error en request-camera-stream: ${e.message}`);
      return { error: e.message };
    }
  }

  @SubscribeMessage('stop-camera-broadcast')
  async handleStopCameraBroadcast(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { cameraId: string }
  ) {
    const { cameraId } = data;

    // 1. Apagar DVR en DB
    try {
      const transmision = await this.transmisionesService.findByCameraId(cameraId);
      if (transmision) {
        await this.transmisionesService.setGrabacion(parseInt(cameraId), transmision.user_id, 'ADMIN', 0);
      }
    } catch(e) {
      this.logger.error(`Error apagando DVR: ${e.message}`);
    }

    // 2. Cerrar y limpiar consumers de todos los clientes
    for (const [id, consumer] of this.consumers.entries()) {
      if (consumer.appData.cameraId === cameraId) {
        consumer.close();
        this.consumers.delete(id);
      }
    }
    this.cameraViewers.delete(cameraId);

    // 3. Matar el stream FFmpeg (esto detendrá la grabación si estaba corriendo)
    this.stopRtspStream(cameraId);

    return true;
  }


  @SubscribeMessage('leave-camera-stream')
  handleLeaveCameraStream(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { cameraId: string }
  ) {
    const { cameraId } = data;
    this.removeViewerFromCamera(client.id, cameraId);

    // Cerrar los consumers del cliente para esta cámara para ahorrar ancho de banda
    for (const [id, consumer] of this.consumers.entries()) {
      if (consumer.appData.consumerSocketId === client.id && consumer.appData.cameraId === cameraId) {
        consumer.close();
        this.consumers.delete(id);
      }
    }

    return true;
  }

  @SubscribeMessage('toggle-dvr')
  async handleToggleDvr(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { cameraId: string, state: boolean }
  ) {
    const { cameraId, state } = data;
    try {
      const transmision = await this.transmisionesService.findByCameraId(cameraId);
      if (!transmision) throw new Error('Transmisión no encontrada');

      if (client.data.user.rol !== 'ADMIN' && transmision.user_id !== client.data.user.id) {
        throw new Error('No tienes permiso');
      }

      // 1. Actualizar DB
      const estado = state ? 1 : 0;
      await this.transmisionesService.setGrabacion(parseInt(cameraId), client.data.user.id, client.data.user.rol, estado);

      // 2. Aplicar dinámicamente si el stream está vivo
      const stream = this.rtspStreams.get(cameraId);
      const recordingMode = process.env.RECORDING_MODE || 'A';
      
      if (stream && recordingMode === 'B') {
        if (state) {
          // Iniciar grabación (solo si no hay una ya activa para evitar dobles procesos)
          const activeProducers = [stream.videoProducer];
          if (stream.audioProducer) activeProducers.push(stream.audioProducer);
          
          this.recordingService.startRecording(
            activeProducers, 
            `rtsp-${cameraId}`, 
            transmision.id, 
            transmision.user_id
          );
        } else {
          // Detener grabación y esperar
          await this.recordingService.stopRecording(`rtsp-${cameraId}`);
        }
      }

      // 3. Notificar a todos el nuevo estado del switch
      this.broadcastCameras();

      return { success: true, grabacion_activa: state };
    } catch (e) {
      this.logger.error(`Error toggling DVR: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  private async removeViewerFromCamera(socketId: string, cameraId: string) {
    const viewers = this.cameraViewers.get(cameraId);
    if (viewers) {
      viewers.delete(socketId);
      if (viewers.size === 0) {
        this.cameraViewers.delete(cameraId);
        // Verificar si la cámara está grabando (DVR = ON)
        try {
          const transmision = await this.transmisionesService.findByCameraId(cameraId);
          if (transmision && Number(transmision.grabacion_activa) === 1) {
            this.logger.log(`Último viewer salió, pero la cámara ${cameraId} está GRABANDO. Persistiendo stream RTSP.`);
            return;
          }
        } catch(e) {}
        
        this.stopRtspStream(cameraId);
      }
    }
  }

  public async stopRtspStream(cameraId: string, intentional = true) {
    const stream = this.rtspStreams.get(cameraId);
    if (stream) {
      this.logger.log(`Deteniendo stream RTSP de cámara: ${cameraId}`);

      // Detener grabación del servidor si está activa
      const recordingMode = process.env.RECORDING_MODE || 'A';
      if (recordingMode === 'B') {
        this.recordingService.stopRecording(`rtsp-${cameraId}`);
      }

      // Notificar al gateway para apagar el FFmpeg
      try {
        const transmision = await this.transmisionesService.findByCameraId(cameraId);
        if (transmision && transmision.gateway) {
          const gatewayId = transmision.gateway.identificador;
          const gatewayEntry = [...this.gateways.entries()].find(([_, gw]) => gw.gatewayId === gatewayId);
          if (gatewayEntry) {
            const [gatewaySocketId] = gatewayEntry;
            this.server.to(gatewaySocketId).emit('stop-rtsp-stream', { cameraId });
          }
        }
      } catch (e) {
        this.logger.error(`Error al detener stream RTSP en gateway local: ${e}`);
      }

      // Cerrar productores
      this.producers.delete(stream.videoProducer.id);
      stream.videoProducer.close();
      
      if (stream.audioProducer) {
        this.producers.delete(stream.audioProducer.id);
        stream.audioProducer.close();
      }

      // Cerrar transportes y remover del map para evitar fugas de memoria
      stream.videoTransport.close();
      this.transports.delete(`gateway_video_${stream.videoTransport.id}`);
      
      if (stream.audioTransport) {
        stream.audioTransport.close();
        this.transports.delete(`gateway_audio_${stream.audioTransport.id}`);
      }

      this.rtspStreams.delete(cameraId);
      this.broadcastCameras();
      
      // Notificar a todos los clientes para que cierren el reproductor de inmediato
      this.server.emit('camera-stopped', { cameraId, intentional });
    }
  }

  private async broadcastCameras() {
    for (const socket of this.server.sockets.sockets.values()) {
      if (!socket.data.isGateway) {
        await this.broadcastCamerasToUser(socket);
      }
    }
  }

  private async broadcastCamerasToUser(client: Socket) {
    if (client.data?.user) {
      try {
        const transList = await this.transmisionesService.getList(client.data.user.id, client.data.user.rol);
        const rtspList = transList.filter(t => t.tipo_origen === 'RTSP');
        client.emit('rtsp-cameras-updated', rtspList.map(t => ({
          id: t.id.toString(),
          name: t.nombre,
          isOnline: this.rtspCamerasStatus.get(t.id.toString()) || false,
          isLive: this.rtspStreams.has(t.id.toString()),
          grabacion_activa: t.grabacion_activa === 1
        })));
      } catch(e) {}
    }
  }

  @SubscribeMessage('cameras-status')
  handleCamerasStatus(
    @ConnectedSocket() client: Socket,
    @MessageBody() statuses: Array<{id: string, isOnline: boolean}>
  ) {
    if (!client.data.isGateway) return;
    let changed = false;
    this.logger.debug(`Recibido status de ${statuses.length} cámaras del gateway ${client.data.gatewayId}`);
    for (const stat of statuses) {
      const prev = this.rtspCamerasStatus.get(stat.id);
      this.logger.debug(`Cam ${stat.id}: Prev=${prev}, New=${stat.isOnline}`);
      if (prev !== stat.isOnline) {
        this.rtspCamerasStatus.set(stat.id, stat.isOnline);
        changed = true;
      }
    }
    if (changed) {
      this.logger.debug('Estado de cámaras cambió, haciendo broadcast...');
      this.broadcastCameras();
    }
  }

  @SubscribeMessage('gateway-stream-failed')
  async handleGatewayStreamFailed(@ConnectedSocket() client: Socket, @MessageBody() data: { cameraId: string }) {
    if (!client.data.isGateway) return;
    this.logger.warn(`Gateway notificó fallo definitivo en cámara ${data.cameraId}`);
    await this.stopRtspStream(data.cameraId, false);
  }
}
