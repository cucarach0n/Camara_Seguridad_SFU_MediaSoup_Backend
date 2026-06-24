import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, OneToMany } from 'typeorm';

@Entity('usuarios')
export class Usuario {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 50, unique: true })
  username: string;

  @Column({ type: 'varchar', length: 255 })
  password_hash: string;

  @Column({ type: 'enum', enum: ['ADMIN', 'USER'], default: 'USER' })
  rol: 'ADMIN' | 'USER';

  @Column({ type: 'tinyint', default: 1 })
  activo: number;

  @CreateDateColumn()
  creado_en: Date;
}
