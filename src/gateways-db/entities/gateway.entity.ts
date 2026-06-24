import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Usuario } from '../../usuarios/entities/usuario.entity';

@Entity('gateways')
export class Gateway {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 100, unique: true })
  identificador: string;

  @Column({ type: 'varchar', length: 100 })
  nombre: string;

  @Column()
  user_id: number;

  @ManyToOne(() => Usuario, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  usuario: Usuario;

  @Column({ type: 'tinyint', default: 0 })
  conectado: number;

  @Column({ type: 'datetime', nullable: true })
  ultimo_ping: Date | null;
}
