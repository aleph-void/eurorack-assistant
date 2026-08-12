import { Sequelize } from 'sequelize';
import { defineModels } from './models.js';

// The app's database handle: a Sequelize instance plus the defined models.
// Extra options (e.g. pg-mem's dialectModule in tests) are passed through to
// the Sequelize constructor.
export function createDatabase({ env = process.env, ...sequelizeOptions } = {}) {
  const url =
    env.DATABASE_URL ||
    `postgres://${env.POSTGRES_USER || 'eurorack'}:${env.POSTGRES_PASSWORD || 'eurorack'}@${
      env.POSTGRES_HOST || 'localhost'
    }:${env.POSTGRES_PORT || 5432}/${env.POSTGRES_DB || 'eurorack'}`;

  const sequelize = new Sequelize(url, {
    dialect: 'postgres',
    logging: false,
    ...sequelizeOptions,
  });

  return {
    sequelize,
    models: defineModels(sequelize),
    close: () => sequelize.close(),
  };
}
