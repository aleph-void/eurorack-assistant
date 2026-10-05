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
    // Sequelize's default pool is five connections. The worker loop and its
    // heartbeat hold some of those, and a browser on HTTP/2 asks for forty
    // panel pictures at once, each a session lookup — queued behind five
    // sockets they arrive one after another. Twenty is well inside the
    // hundred Postgres allows by default and leaves room for a second
    // process.
    pool: { max: 20, min: 2, idle: 10000, acquire: 30000 },
    ...sequelizeOptions,
  });

  return {
    sequelize,
    models: defineModels(sequelize),
    close: () => sequelize.close(),
  };
}
