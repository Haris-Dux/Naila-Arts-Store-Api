import { RedisConfig } from '../config/configuration';

/** Single place that turns typed Redis config into a connection URL. */
export function redisUrl(config: RedisConfig): string {
  const auth = config.password ? `:${encodeURIComponent(config.password)}@` : '';
  return `redis://${auth}${config.host}:${config.port}/${config.db}`;
}
