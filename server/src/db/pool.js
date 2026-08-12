import pg from 'pg';

export function createPool(env = process.env) {
  return new pg.Pool({
    connectionString:
      env.DATABASE_URL ||
      `postgres://${env.POSTGRES_USER || 'eurorack'}:${env.POSTGRES_PASSWORD || 'eurorack'}@${
        env.POSTGRES_HOST || 'localhost'
      }:${env.POSTGRES_PORT || 5432}/${env.POSTGRES_DB || 'eurorack'}`,
  });
}
