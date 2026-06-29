import * as dgram from 'dgram';
import { AddressInfo } from 'net';

export class RtpProxy {
  private server: dgram.Socket;
  public proxyPort: number = 0;
  
  private initialSsrc: number | null = null;
  private currentSsrc: number | null = null;
  
  private lastSeq: number = 0;
  private lastTs: number = 0;
  
  private seqOffset: number = 0;
  private tsOffset: number = 0;
  private mainPt?: number;
  private clockRate: number = 90000;
  private lastPacketTime: number = Date.now();

  constructor(private targetPort: number, private targetIp: string = '127.0.0.1') {
    this.server = dgram.createSocket('udp4');
    
    this.server.on('message', (msg, rinfo) => {
      // Ignore packets from FFmpeg itself
      if (rinfo.port === this.targetPort || rinfo.port === this.targetPort + 1) return;

      if (msg.length >= 12) {
        const pt = msg.readUInt8(1) & 0x7F;

        // Validar si es RTP real y no RTCP (PT 200-206)
        if (pt >= 200 && pt <= 206) {
          return; // Ignore RTCP
        }

        // Si tenemos un PT principal configurado, ignorar todos los demas (e.g. RTX, FEC, Padding)
        if (this.mainPt !== undefined && pt !== this.mainPt) {
          return;
        }

        const currentSeq = msg.readUInt16BE(2);
        const currentTs = msg.readUInt32BE(4);
        const currentSsrc = msg.readUInt32BE(8);

        if (this.initialSsrc === null) {
          // Primer paquete recibido: Guardar como ancla
          this.initialSsrc = currentSsrc;
          this.currentSsrc = currentSsrc;
          this.lastSeq = currentSeq;
          this.lastTs = currentTs;
          this.lastPacketTime = Date.now();
        } else {
          if (currentSsrc !== this.currentSsrc) {
            // ¡Reconexión detectada! (Nuevo flujo RTP)
            const now = Date.now();
            const elapsedMs = now - this.lastPacketTime;
            // Avanzar el RTP clock la cantidad exacta de tiempo que estuvimos desconectados
            const elapsedTicks = Math.floor(elapsedMs * (this.clockRate / 1000));
            
            this.seqOffset = (this.lastSeq + 1 - currentSeq) & 0xFFFF;
            this.tsOffset = (this.lastTs + elapsedTicks - currentTs) >>> 0; 
            this.currentSsrc = currentSsrc;
          }

          if (this.initialSsrc !== currentSsrc) {
            // Aplicar offsets para engañar a FFmpeg
            const newSeq = (currentSeq + this.seqOffset) & 0xFFFF;
            const newTs = (currentTs + this.tsOffset) >>> 0;
            
            msg.writeUInt16BE(newSeq, 2);
            msg.writeUInt32BE(newTs, 4);
            msg.writeUInt32BE(this.initialSsrc, 8);
            
            this.lastSeq = newSeq;
            this.lastTs = newTs;
            this.lastPacketTime = Date.now();
          } else {
            // Flujo normal, solo actualizamos el último valor visto
            this.lastSeq = currentSeq;
            this.lastTs = currentTs;
            this.lastPacketTime = Date.now();
          }
        }
      }
      this.server.send(msg, this.targetPort, this.targetIp);
    });
  }

  setMainPt(pt: number, clockRate: number = 90000) {
    this.mainPt = pt;
    this.clockRate = clockRate;
  }

  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.bind(0, '127.0.0.1', () => {
        this.proxyPort = (this.server.address() as AddressInfo).port;
        resolve(this.proxyPort);
      });
    });
  }

  stop() {
    try { this.server.close(); } catch(e) {}
  }
}
