import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Usuario } from '../../usuarios/entities/usuario.entity';
import { Gateway } from '../../gateways-db/entities/gateway.entity';

@Entity('transmisiones')
export class Transmision {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  user_id: number;

  @ManyToOne(() => Usuario, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  usuario: Usuario;

  @Column({ nullable: true })
  gateway_id: number | null;

  @ManyToOne(() => Gateway, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'gateway_id' })
  gateway: Gateway | null;

  @Column({ type: 'enum', enum: ['NAVEGADOR', 'RTSP'] })
  tipo_origen: 'NAVEGADOR' | 'RTSP';

  @Column({ type: 'varchar', length: 100 })
  nombre: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  url_rtsp: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  productor_id: string | null;

  @Column({ type: 'tinyint', default: 0 })
  activa: number;

  @Column({ type: 'tinyint', default: 0 })
  grabacion_activa: number;

  @CreateDateColumn()
  creado_en: Date;
}
