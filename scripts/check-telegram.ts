/**
 * Comprueba el token del bot contra la API de Telegram sin arrancar el puente.
 * Uso: npm run check:telegram
 */
import { loadConfig } from '../src/config';

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function call<T>(token: string, method: string): Promise<TelegramResponse<T>> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`);
  return (await response.json()) as TelegramResponse<T>;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const token = config.telegram.token;

  const me = await call<{ id: number; username: string; first_name: string; can_read_all_group_messages: boolean }>(
    token,
    'getMe'
  );
  if (!me.ok || !me.result) {
    console.error(`Token rechazado por Telegram: ${me.description ?? 'sin detalle'}`);
    process.exit(1);
  }

  console.log(`Bot: @${me.result.username} (${me.result.first_name}, id ${me.result.id})`);

  const webhook = await call<{ url: string; pending_update_count: number }>(token, 'getWebhookInfo');
  if (webhook.ok && webhook.result?.url) {
    console.warn(
      `Aviso: hay un webhook configurado (${webhook.result.url}). El puente usa long polling y fallara; ` +
        'elimina el webhook con deleteWebhook antes de arrancar.'
    );
  } else {
    console.log('Webhook: ninguno (long polling disponible)');
  }

  const allowed = config.telegram.allowedUserIds;
  console.log(
    allowed.length > 0
      ? `Allowlist: ${allowed.length} usuario(s) autorizado(s)`
      : 'Allowlist: vacia -> el bot solo devolvera el user id, no ejecutara ordenes'
  );
}

main().catch((error: unknown) => {
  console.error(`No pude comprobar el token: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
