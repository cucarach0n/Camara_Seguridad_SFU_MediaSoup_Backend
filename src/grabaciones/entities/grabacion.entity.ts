import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Usuario } from '../../usuarios/entities/usuario.entity';
import { Transmision } from '../../transmisiones/entities/transmision.entity';

@Entity('grabaciones')
export class Grabacion {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  user_id: number;

  @ManyToOne(() => Usuario, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  usuario: Usuario;

  @Column({ nullable: true })
  transmision_id: number | null;

  @ManyToOne(() => Transmision, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'transmision_id' })
  transmision: Transmision | null;

  @Column({ type: 'varchar', length: 255 })
  nombre_archivo: string;

  @Column({ type: 'varchar', length: 500 })
  ruta_archivo: string;

  @Column({ type: 'int', nullable: true })
  duracion_segundos: number | null;

  @Column({ type: 'bigint', nullable: true })
  tamanio_bytes: number | null;

  @Column({ type: 'tinyint', default: 0 })
  subido_drive: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  url_drive: string | null;

  @CreateDateColumn()
  creado_en: Date;
}
