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
        } else {
          if (currentSsrc !== this.currentSsrc) {
            // ¡Reconexión detectada! (Nuevo flujo RTP)
            // Calculamos offsets para que los Sequence Numbers y Timestamps continúen suavemente
            this.seqOffset = (this.lastSeq + 1 - currentSeq) & 0xFFFF;
            // Agregamos un pequeño salto de 1 segundo (90000 ticks) para simular pérdida natural
            this.tsOffset = (this.lastTs + 90000 - currentTs) >>> 0; 
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
          } else {
            // Flujo normal, solo actualizamos el último valor visto
            this.lastSeq = currentSeq;
            this.lastTs = currentTs;
          }
        }
      }
      this.server.send(msg, this.targetPort, this.targetIp);
    });
  }

  setMainPt(pt: number) {
    this.mainPt = pt;
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
