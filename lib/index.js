export const name = 'dsh-message-forward';

export function apply(ctx) {
  const logger = ctx.logger?.('forward') || console;
  logger.info?.('dsh-message-forward host plugin initialized successfully');
}
