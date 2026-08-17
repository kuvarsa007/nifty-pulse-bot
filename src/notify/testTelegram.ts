/**
 * Quick test: npm run telegram:test
 * Requires TELEGRAM_ENABLED=true + token + chat id in .env
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env') });

import { sendTelegram } from './telegram';

async function main(): Promise<void> {
  console.log(`cwd: ${process.cwd()}`);
  console.log(`TELEGRAM_ENABLED=${process.env.TELEGRAM_ENABLED}`);
  console.log(`TOKEN set=${Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim())}`);
  console.log(`CHAT_ID set=${Boolean(process.env.TELEGRAM_CHAT_ID?.trim())}`);
  console.log('Sending test message to Telegram...');
  await sendTelegram(
    `NiftyPulse test\n` +
      `Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST\n` +
      `If you see this, alerts are working.`
  );
  console.log('Done. Check your Telegram chat with @Nifty_pluse_bot');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
